#!/usr/bin/env python3
"""Strict patch verification, isolated C build, constructive private fixtures."""
from pathlib import Path
import hashlib,json,os,resource,shlex,shutil,signal,subprocess,time

HERE=Path(__file__).resolve().parent
REPO=HERE.parents[1]
CACHE=HERE/'.cache'
SOURCE=CACHE/'source'
BUILD=CACHE/'build'
VENDOR=REPO/'.build/vendor/litter-ish-owned'
NATIVE=CACHE/'workspace'
ROOT=CACHE/'rootfs'
LIMIT=2*1024**3


def sha(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()


def inventory(root):
    return {str(p.relative_to(root)):('link:'+os.readlink(p) if p.is_symlink() else sha(p))
            for p in root.rglob('*') if p.is_symlink() or p.is_file()}


def cache_bytes():
    return sum(p.stat().st_size for p in CACHE.rglob('*') if p.is_file() and not p.is_symlink())


def guard():
    used=cache_bytes()
    if used>LIMIT:raise RuntimeError('2 GiB private cache ceiling exceeded; stop')
    return used


def native_limits():
    resource.setrlimit(resource.RLIMIT_CPU,(150,170))
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))


def bounded(argv, name, env, cwd=HERE, timeout=180, stdin=None):
    assert timeout<=180
    guard();start=time.monotonic()
    logpath=CACHE/(name+'.log')
    with logpath.open('wb') as log:
        proc=subprocess.Popen(argv,cwd=cwd,env=env,stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
            stdout=log,stderr=subprocess.STDOUT,start_new_session=True,preexec_fn=native_limits)
        if stdin is not None:
            proc.stdin.write(stdin);proc.stdin.close()
        stopped=None
        try:
            while proc.poll() is None:
                guard()
                if time.monotonic()-start>timeout:raise RuntimeError('external host deadline')
                time.sleep(.1)
        except BaseException as error:
            stopped=str(error);os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=3)
    result={'command':argv,'host_seconds':round(time.monotonic()-start,4),'exit':proc.returncode,
            'deadline_seconds':timeout,'stopped':stopped,'log':str(logpath.relative_to(HERE))}
    try:os.killpg(proc.pid,0)
    except ProcessLookupError:result['host_process_group_gone']=True
    else:
        result['host_process_group_gone']=False;os.killpg(proc.pid,signal.SIGKILL)
    return result


def main():
    CACHE.mkdir(exist_ok=True)
    (HERE/'reports').mkdir(exist_ok=True)
    baseline=json.loads((HERE/'baseline.json').read_text())
    if sha(HERE/'readonly-parent-candidate.patch')!=baseline['patch_sha256']:
        raise RuntimeError('Patch hash differs from the recorded patch')
    if sha(VENDOR/baseline['file'])!=baseline['sha256']:raise RuntimeError('Prepared vendor has changed; refusing a different baseline')
    original=inventory(VENDOR)
    report={'scope':'Actual Mac iSH kernel; ordinary private workspace only. No phone, auth, model, external mount or escape probes.',
            'limits':{'cache_bytes':LIMIT,'jobs':2,'max_seconds_per_run':180},'steps':[],'passed':False}
    def save():(HERE/'reports/result.json').write_text(json.dumps(report,indent=2)+'\n')
    env={k:v for k,v in os.environ.items() if k not in ['ISH_BIND_MOUNTS','ISH_NATIVE_OFFLOAD','ISH_ENABLE_SESSION_JOBS',
          'ISH_ENABLE_WORKSPACE_POLICY','ISH_POLICY_READ_ROOTS','ISH_POLICY_WRITE_ROOTS','ALMA_PRIVATE_NATIVE_WORKSPACE',
          'ALMA_VALIDATE_GRANTS_ONLY','IPHONEOS_DEPLOYMENT_TARGET','SDKROOT','CFLAGS','LDFLAGS']}
    env['PATH']=str(REPO/'tools/alma-ios-lab/.cache/phone-build-bin')+os.pathsep+str(REPO/'tools/alma-ios-lab/.cache/ish-tools/bin')+os.pathsep+env['PATH']
    env['GIT_CEILING_DIRECTORIES']=str(CACHE)
    def run(argv,name,**kwargs):
        result=bounded(argv,name,kwargs.pop('env',env),**kwargs)
        report['steps'].append(result);save()
        if result['exit']!=0 or result['stopped']:raise RuntimeError(name+' failed; see '+result['log'])
        return result
    try:
        if not SOURCE.exists():shutil.copytree(VENDOR,SOURCE,symlinks=True)
        current=sha(SOURCE/baseline['file'])
        patch=str(HERE/'readonly-parent-candidate.patch')
        if current==baseline['patched_sha256']:
            run(['git','apply','--reverse','--check',patch],'reverse-check-existing',cwd=SOURCE)
            run(['git','apply','--reverse',patch],'reverse-existing',cwd=SOURCE)
        if inventory(SOURCE)!=original:raise RuntimeError('Private source differs from prepared vendor; preserving it')
        run(['git','apply','--check','--whitespace=error-all',patch],'strict-apply-check',cwd=SOURCE)
        run(['git','apply','--whitespace=error-all',patch],'apply',cwd=SOURCE)
        run(['git','apply','--reverse','--check',patch],'reverse-check',cwd=SOURCE)
        run(['git','apply','--reverse',patch],'reverse',cwd=SOURCE)
        if inventory(SOURCE)!=original:raise RuntimeError('Reverse failed to restore exact baseline')
        run(['git','apply','--whitespace=error-all',patch],'reapply',cwd=SOURCE)
        changed=[k for k,v in inventory(SOURCE).items() if original.get(k)!=v]
        assert changed==[baseline['file']],changed
        report['strict_patch_verified']=True
        report['changed_paths']=changed
        # Pure struct identities: no host directory alias or mount fixtures.
        text=(SOURCE/baseline['file']).read_text()
        (CACHE/'policy_helpers.inc').write_text(text[text.index('static bool same_identity'):text.index('static void free_grant')])
        run(['cc','-std=c11','-I'+str(CACHE),str(HERE/'tests/identity_checks.c'),'-o',str(CACHE/'identity-checks')],'identity-build')
        run([str(CACHE/'identity-checks')],'identity-run',timeout=10)
        if not (BUILD/'build.ninja').exists():
            run(['meson','setup',str(BUILD),str(SOURCE),'-Dguest_arch=arm64','-Dkernel=ish','-Dno_crlf=true','--buildtype=release'],'meson')
        run(['ninja','-C',str(BUILD),'-j','2','ish'],'kernel-build')
        # Private harness only. The patch changes no host/Rust API or main.c.
        main=(SOURCE/'main.c').read_text()
        needle='int e=ish_workspace_enable();'
        assert main.count(needle)==1
        main=main.replace(needle,'const char *fixture=getenv("ALMA_PRIVATE_NATIVE_WORKSPACE"); if(fixture && ish_workspace_mount_native(fixture)<0) return 91; '+needle)
        needle='const char *raw_ro=getenv("ISH_POLICY_READ_ROOTS"), *raw_rw=getenv("ISH_POLICY_WRITE_ROOTS");'
        assert main.count(needle)==1
        main=main.replace(needle,'if(getenv("ALMA_VALIDATE_GRANTS_ONLY")) return ordinary_grant_checks(); '+needle)
        pos=main.index('static void crash_handler')
        main=main[:pos]+(HERE/'tests/grant_checks.c').read_text()+'\n'+main[pos:]
        (CACHE/'native_main.c').write_text('int ish_workspace_mount_native(const char *source);\n'+main)
        commands=json.loads((BUILD/'compile_commands.json').read_text())
        compile=shlex.split(next(x['command'] for x in commands if x['file'].endswith('/main.c')))
        compile[compile.index('-o')+1]=str(CACHE/'native-main.o');compile[compile.index('-c')+1]=str(CACHE/'native_main.c')
        run(compile,'native-main-build',cwd=BUILD)
        links=subprocess.check_output(['ninja','-C',str(BUILD),'-t','commands','ish'],text=True,timeout=10)
        link=shlex.split(links.splitlines()[-1]);link[link.index('-o')+1]=str(CACHE/'native-ish')
        link=[str(CACHE/'native-main.o') if v=='ish.p/main.c.o' else v for v in link]
        run(link,'native-link',cwd=BUILD)
        source_root=REPO/'tools/alma-ios-lab/.cache/runtime-rootfs/354d49ec25295e6c/fs'
        root_before=inventory(source_root)
        if not ROOT.exists():shutil.copytree(source_root,ROOT,symlinks=True)
        for p in ROOT.rglob('*'):
            if p.is_symlink():raise RuntimeError('Unexpected host symlink in copied rootfs; no target access attempted')
        for part in ['test','view/inbox','view/outbox/revision_v0','view/outbox/revision_v1','scratch/home']:
            (NATIVE/part).mkdir(parents=True,exist_ok=True)
        (NATIVE/'view/inbox/source.txt').write_text('readonly input\n')
        (NATIVE/'view/outbox/revision_v0/accepted.txt').write_text('accepted independent copy\n')
        (NATIVE/'view/outbox/revision_v1/seed.txt').write_text('candidate seed\n')
        shutil.copyfile(HERE/'tests/worker.py',NATIVE/'test/worker.py')
        binary=str(CACHE/'native-ish')
        run([binary,'-f',str(ROOT),'/bin/sh','-c','mkdir -p /controller; cat > /controller/main.py'],'install-controller',
            timeout=15,stdin=(HERE/'tests/controller.py').read_bytes())
        policy=dict(env,ISH_ENABLE_SESSION_JOBS='1',ISH_ENABLE_WORKSPACE_POLICY='1',ALMA_PRIVATE_NATIVE_WORKSPACE=str(NATIVE),
            ISH_POLICY_READ_ROOTS='/bin:/sbin:/usr:/lib:/etc:/workspace/test:/workspace/view',ISH_POLICY_WRITE_ROOTS='/workspace/scratch')
        checked=run([binary,'-f',str(ROOT),'/bin/true'],'grant-validation',env=dict(policy,ALMA_VALIDATE_GRANTS_ONLY='1'),timeout=20)
        assert 'GRANT_VALIDATION_PASS' in (HERE/checked['log']).read_text()
        report['roles']=[]
        for role in ['guardian','actor']:
            (NATIVE/'test/role.txt').write_text(role)
            role_env=dict(policy)
            if role=='actor':role_env['ISH_POLICY_WRITE_ROOTS']+=':/workspace/view/outbox/revision_v1'
            result=run([binary,'-f',str(ROOT),'/usr/bin/python3','-B','/controller/main.py'],role,env=role_env,timeout=45)
            lines=(HERE/result['log']).read_text().splitlines()
            controller=json.loads(next(line for line in lines if line.startswith('{')))
            worker=json.loads(controller['stdout'])
            assert controller['exit']==0 and controller['cleanup_confirmed'] and worker['passed'],controller
            assert controller['premature_release_rejected'] and controller['retired_grant_reuse_rejected']
            report['roles'].append({'role':role,'host_seconds':result['host_seconds'],'controller':controller,'worker':worker})
        assert (NATIVE/'view/inbox/source.txt').read_text()=='readonly input\n'
        assert (NATIVE/'view/outbox/revision_v0/accepted.txt').read_text()=='accepted independent copy\n'
        assert (NATIVE/'view/outbox/revision_v1/nested/result.txt').read_text()=='Actor 中文\n'
        report['native_readback_matches']=True
        report['shared_rootfs_unchanged']=inventory(source_root)==root_before
        report['passed']=True
    except BaseException as error:
        report['error']=str(error)
    finally:
        report['shared_vendor_unchanged']=inventory(VENDOR)==original
        report['cache_bytes']=cache_bytes()
        report['patch_sha256']=sha(HERE/'readonly-parent-candidate.patch')
        report['test_sha256']={str(p.relative_to(HERE)):sha(p) for p in [HERE/'run.py',*(HERE/'tests').glob('*')] if p.is_file()}
        if (CACHE/'native-ish').exists():report['binary_sha256']=sha(CACHE/'native-ish')
        if not report['shared_vendor_unchanged'] or report['cache_bytes']>LIMIT:report['passed']=False
        save()
    print(json.dumps({'passed':report['passed'],'cache_bytes':report['cache_bytes'],'error':report.get('error')},indent=2))
    raise SystemExit(0 if report['passed'] else 1)


if __name__=='__main__':main()
