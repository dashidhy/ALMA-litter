#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/types.h>
#define WP_READ 1
#define WP_WRITE 2
struct wp_identity { dev_t dev; ino_t ino; };
struct wp_root { char path[128]; unsigned rights, depth; struct wp_identity ancestry[64]; };
static bool under(const char *path,const char *root) {
    size_t n=strlen(root);return !strncmp(path,root,n) && (path[n]=='/' || !path[n]);
}
/* Generated verbatim from the patched file, not a second policy implementation. */
#include "policy_helpers.inc"
int main(void) {
    struct wp_root parent={.path="/workspace/view",.rights=WP_READ,.depth=2,
        .ancestry={{1,1},{1,2}}};
    struct wp_root child={.path="/workspace/view/outbox/revision_v1",.rights=WP_READ|WP_WRITE,.depth=4,
        .ancestry={{1,1},{1,2},{1,3},{1,4}}};
    assert(verified_readonly_parent_candidate(&parent,&child));
    child.ancestry[0].ino=9;
    assert(!verified_readonly_parent_candidate(&parent,&child));
    child.ancestry[0].ino=1;
    child.depth=2;
    assert(!verified_readonly_parent_candidate(&parent,&child));
    child.depth=4;
    assert(!verified_readonly_parent_candidate(&child,&parent));
    strcpy(child.path,parent.path);
    assert(!verified_readonly_parent_candidate(&parent,&child));
    puts("IDENTITY_CHECKS_PASS:5");
    return 0;
}
