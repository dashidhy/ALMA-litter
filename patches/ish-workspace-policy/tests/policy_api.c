// Native-host API test. Only the private prepared fixture root is mounted.
#include <assert.h>
#include <stdio.h>
#include "embed/ffi.h"
#include "kernel/session_job.h"
int main(int argc,char **argv) {
    assert(argc==2);
    assert(ish_ffi_mount_fakefs(argv[1])==0);
    assert(ish_ffi_become_init()==0);
    assert(ish_ffi_mount_procfs()==0);
    assert(ish_ffi_mount_devpts()==0);
    assert(ish_ffi_enable_session_jobs()==0);
    assert(ish_ffi_workspace_policy_enable()==0);
    const char *ro[]={"/bin","/usr","/lib","/etc","/policy/input"};
    const char *rw[]={"/policy/candidate","/policy/tmp"};
    assert(ish_ffi_workspace_grant_create(ro,5,rw,2,1)<0); // unsupported allow-network shape
    const char *bad[]={"/policy/../input"};
    assert(ish_ffi_workspace_grant_create(bad,1,rw,2,0)<0);
    int first=ish_ffi_workspace_grant_create(ro,5,rw,2,0);assert(first>0);
    assert(ish_ffi_workspace_grant_create(ro,5,rw,2,0)==-16); // overlapping writer
    int reader=ish_ffi_workspace_grant_create(ro,5,NULL,0,0);assert(reader>first);
    assert(ish_ffi_workspace_grant_release(reader)==0);
    assert((int)ish_job_control(ISH_JOB_NEW,0)<0); // no permissive default
    int job=ish_job_control(ISH_JOB_NEW_GRANTED,first);assert(job>0);
    assert(ish_ffi_workspace_grant_release(first)==-16); // still bound, even before fork
    assert(ish_ffi_workspace_grant_create(ro,5,rw,2,0)==-16);
    assert(ish_job_control(ISH_JOB_DISARM,job)==0);
    assert(ish_job_control(ISH_JOB_RELEASE,job)==0);
    assert((int)ish_job_control(ISH_JOB_NEW_GRANTED,first)<0); // single use, never remint
    int next=ish_ffi_workspace_grant_create(ro,5,rw,2,0);assert(next>reader);
    assert(ish_ffi_workspace_grant_release(next)==0);
    puts("WORKSPACE_NATIVE_API_PASS");
    return 0;
}
