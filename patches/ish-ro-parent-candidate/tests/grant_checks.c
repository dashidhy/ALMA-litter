/* Included only in the private host test entry, never in the delivered patch. */
int ish_workspace_register(const char *const *,size_t,const char *const *,size_t,unsigned);
int ish_workspace_release(unsigned);
static int ordinary_grant_checks(void) {
    const char *parent="/workspace/view", *child="/workspace/view/outbox/revision_v1";
    const char *ro_parent[]={parent}, *rw_child[]={child};
    const char *duplicate[]={parent,parent};
    const char *nested_ro[]={parent,child};
    const char *ro_child[]={child}, *rw_parent[]={parent};
    const char *runtime[]={"/usr"}, *nested_rw[]={parent,child};
    if (ish_workspace_register(duplicate,2,NULL,0,0)!=-95) return 81;
    if (ish_workspace_register(ro_parent,1,rw_parent,1,0)!=-95) return 82;
    if (ish_workspace_register(nested_ro,2,NULL,0,0)!=-95) return 83;
    if (ish_workspace_register(ro_child,1,rw_parent,1,0)!=-95) return 84;
    if (ish_workspace_register(runtime,1,nested_rw,2,0)!=-95) return 85;
    int actor=ish_workspace_register(ro_parent,1,rw_child,1,0);
    if (actor<=0) return 86;
    /* Other records still conflict even if a prior grant is not yet bound. */
    if (ish_workspace_register(ro_parent,1,NULL,0,0)!=-16) return 87;
    if (ish_workspace_release(actor)!=0) return 88;
    int guardian=ish_workspace_register(ro_parent,1,NULL,0,0);
    if (guardian<=0 || ish_workspace_release(guardian)!=0) return 89;
    puts("GRANT_VALIDATION_PASS");
    return 0;
}
