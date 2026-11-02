import { AuthOperationError } from '../upstream/src/auth-prototype/protocol.js';
import type { AuthService } from '../upstream/src/auth-prototype/service.js';
import { TahAttemptExecutionErrorV1, type TahFrameworkAttemptPortV1 } from '../upstream/src/framework/workflow.js';
import type { BoundedTahHostOperationSchedulerV1 } from '../upstream/src/host/operation-scheduler.js';
import type { AppProviderProfile } from '../upstream/src/app-runtime/attempt-port.js';
import { isAppModelAllowed } from '../upstream/src/app-runtime/model-policy.js';
import type { MobileProviderAdapter } from './provider.js';

/** Same auth/scheduler/admission semantics as Mac serviceAttemptPort, with a
 * native mobile execution transport in place of the SuperBox process transport. */
export function mobileAttemptPort(auth: AuthService, scheduler: BoundedTahHostOperationSchedulerV1,
  profiles: readonly AppProviderProfile[], adapters: ReadonlyMap<string, MobileProviderAdapter>): TahFrameworkAttemptPortV1 {
  return {run(built,onEvent,signal) {
    const profile=profiles.find(p=>p.id===built.attempt.providerID), adapter=adapters.get(built.attempt.providerID);
    if(!profile||!adapter||!isAppModelAllowed(profile,built.attempt.inference.modelID))throw new TahAttemptExecutionErrorV1('unavailable');
    return scheduler.schedule({declaredInputBytes:[...built.inputBytes.values()].reduce((n,b)=>n+b.byteLength,0),signal,
      run:async scheduledSignal=>{
        const epoch=auth.identityVersion;
        try {
          const result=await auth.withCredential(profile.id,(bytes,authorizationSignal)=>adapter.run(built,bytes,onEvent,authorizationSignal),scheduledSignal);
          if(result.terminal.kind==='failed'&&result.terminal.failure.family==='authentication')void auth.reportAuthenticationInvalid(profile.id,epoch).catch(()=>{});
          if(result.terminal.kind==='failed'&&result.terminal.failure.family==='cleanup')throw new AuthOperationError('cleanup');
          return result;
        }catch(error){
          if(error instanceof AuthOperationError&&error.code==='cleanup')throw new TahAttemptExecutionErrorV1('cleanup_unconfirmed');
          if(scheduledSignal.aborted)throw new TahAttemptExecutionErrorV1('cancelled');
          throw new TahAttemptExecutionErrorV1('unavailable');
        }
      }});
  }};
}
