
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import App from '../App';
import {UIController} from '../controller';
import {makeFixture} from '../devFixture';
import type {Call,Commands} from '../contract';
let host:HTMLDivElement, root:Root;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();vi.unstubAllGlobals();});
function button(name:string){return [...host.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===name||b.textContent===name)!;}
it('normal native loading gates reader tabs; completed raw Markdown becomes real DOM',async()=>{
 const f=makeFixture();const c=new UIController(f.transport.call as Call);
 await act(async()=>root.render(<App controller={c}/>));
 await act(async()=>button('Read source').click());
 await act(async()=>button('Notes').click());
 f.snapshot.presentation.material!.isLoading=true;f.snapshot.presentation.material!.text=null;f.snapshot.presentation.isBusy=true;f.snapshot.presentation.permissions.readMaterial=false;
 await act(async()=>{await c.readSnapshot();});
 expect(button('ASR terms').disabled).toBe(true);expect(button('Notes').disabled).toBe(true);expect(host.textContent).toContain('Loading material');
 f.snapshot.presentation.material!.isLoading=false;f.snapshot.presentation.material!.text='# Actual heading\n\n| a | b |\n|---|---|\n|1|2|\n\n```js\nconst a = 1;\n```';f.snapshot.presentation.isBusy=false;f.snapshot.presentation.permissions.readMaterial=true;
 await act(async()=>{await c.readSnapshot();});
 expect(host.querySelector('.material-content h1')?.textContent).toBe('Actual heading');expect(host.querySelector('.material-content table')).not.toBeNull();expect(host.querySelector('.material-content pre code')?.textContent).toContain('const a');
});
it('does not relabel old Notes as ASR when native read admission returns unchanged material',async()=>{
 const f=makeFixture();const call:Call=async(method,value)=>{
  if(method==='readMaterial'&&(value as Commands['readMaterial']).file==='suspicious-asr-terms.md'){
   // Exact native guard behavior: background refresh acquired commandBusy after frontend's last poll.
   f.calls.push({method,value:structuredClone(value)});f.snapshot.presentation.isBusy=true;f.snapshot.presentation.permissions.readMaterial=false;return structuredClone(f.snapshot);
  }
  return f.transport.call(method,value);
 };
 const c=new UIController(call);await act(async()=>root.render(<App controller={c}/>));await act(async()=>button('Read source').click());await act(async()=>button('Notes').click());
 const oldHeading=host.querySelector('.material-content h1')?.textContent;
 await act(async()=>button('ASR terms').click());
 expect(button('ASR terms').getAttribute('aria-pressed')).toBe('false');
 expect(button('Notes').getAttribute('aria-pressed')).toBe('true');
 expect(host.querySelector('.material-content h1')?.textContent).toBe(oldHeading);
 expect(host.querySelector('.material-heading h2')?.textContent).toBe('v1 · Notes');
 expect(host.querySelector('[role="alert"]')?.textContent).toContain('requested material did not open');
});
it('keeps new model defaults when user changes Web while model normalization acknowledgement is pending',async()=>{
 vi.useFakeTimers();const f=makeFixture();f.snapshot.presentation.models.push({id:'new-model',title:'New model',enabled:true});let release!:()=>void;const pending=new Promise<void>(r=>release=r);let delayed=false;
 const call:Call=async(method,value)=>{
  const old=f.snapshot.draft.settings.modelID;
  const result=await f.transport.call(method,value);
  if(method==='updateDraft'&&old!==f.snapshot.draft.settings.modelID){
   // Original Swift updateDraft -> chooseModelDefaults, before returning its normalized snapshot.
   f.snapshot.draft.settings.reasoningEffortID='medium';f.snapshot.draft.settings.contextWindowTokens=64000;
   f.snapshot.presentation.efforts=[{id:'medium',title:'Medium',enabled:true}];f.snapshot.presentation.contextWindows=[{id:64000,title:'64000',enabled:true}];
   const ack=structuredClone(f.snapshot);if(!delayed){delayed=true;await pending;}return ack;
  }
  return result;
 };
 const c=new UIController(call);await act(async()=>root.render(<App controller={c}/>));await act(async()=>button('Open settings').click());
 const model=[...host.querySelectorAll('label')].find(l=>l.textContent?.startsWith('Model'))!.querySelector('select')!;
 await act(async()=>{model.value='new-model';model.dispatchEvent(new Event('change',{bubbles:true}));});
 await act(async()=>{await vi.advanceTimersByTimeAsync(250);});
 await act(async()=>{(host.querySelector('input[role="switch"]') as HTMLInputElement).click();});
 await act(async()=>{release();await Promise.resolve();await Promise.resolve();});
 await act(async()=>{await vi.advanceTimersByTimeAsync(250);});
 expect(c.getSnapshot().draft?.settings.reasoningEffortID).toBe('medium');expect(c.getSnapshot().draft?.settings.contextWindowTokens).toBe(64000);
 expect(c.getSnapshot().draft?.settings.webEnabled).toBe(true);
 const updates=f.calls.filter(x=>x.method==='updateDraft');
 expect(updates).toHaveLength(2);
 expect((updates[1].value as Commands['updateDraft']).draft.settings).toMatchObject({modelID:'new-model',reasoningEffortID:'medium',contextWindowTokens:64000,webEnabled:true});
 expect([...host.querySelectorAll('label')].find(l=>l.textContent?.startsWith('Reasoning'))!.querySelector('select')!.value).toBe('medium');
});
