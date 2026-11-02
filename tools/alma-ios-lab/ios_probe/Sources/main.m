#import <UIKit/UIKit.h>
#import <Foundation/Foundation.h>
#import <mach/mach.h>
#import <os/proc.h>
#import <stdatomic.h>

#ifndef ALMA_PROBE_FUNCTION
#define ALMA_PROBE_FUNCTION alma_ish_probe_run
#endif
#ifndef ALMA_PROBE_TITLE
#define ALMA_PROBE_TITLE @"Alma iSH Probe"
#endif
#ifndef ALMA_PROBE_SCOPE
#define ALMA_PROBE_SCOPE @"Pinned iSH Rust embedding/supervisor on iPhone; no Codex model, ASR or Litter App integration"
#endif
extern void ALMA_PROBE_FUNCTION(const char *, const char *, void (*)(const char *));
static UILabel *label;
static NSString *documents, *runID, *phase=@"ready";
static NSMutableArray *cases;
static NSDictionary *summary;
static double began, phaseBegan;
static NSUInteger phaseDeadline=90;
static uint64_t peak, casePeak;
static atomic_bool stopped;

static uint64_t footprint(void) {
    task_vm_info_data_t info={0};mach_msg_type_number_t n=TASK_VM_INFO_COUNT;
    return task_info(mach_task_self(),TASK_VM_INFO,(task_info_t)&info,&n)==KERN_SUCCESS?info.phys_footprint:0;
}
static void saveStatus(NSString *reason) {
    uint64_t mem=footprint();peak=MAX(peak,mem);casePeak=MAX(casePeak,mem);
    NSDictionary *disk=[[NSFileManager defaultManager] attributesOfFileSystemForPath:documents error:nil];
    NSDictionary *report=@{@"runID":runID?:@"",@"phase":phase,@"reason":reason?:@"",
        @"elapsedSeconds":@(CACurrentMediaTime()-began),@"footprintBytes":@(mem),@"peakFootprintBytes":@(peak),
        @"availableMemoryBytes":@(os_proc_available_memory()),@"freeDiskBytes":disk[NSFileSystemFreeSize]?:@0,
        @"thermalState":@([NSProcessInfo processInfo].thermalState),@"cases":cases?:@[],@"summary":summary?:@{},
        @"scope":ALMA_PROBE_SCOPE};
    NSData *data=[NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:nil];
    [data writeToFile:[documents stringByAppendingPathComponent:@"status.json"] options:NSDataWritingAtomic error:nil];
    [data writeToFile:[documents stringByAppendingPathComponent:[NSString stringWithFormat:@"report-%@.json",runID]] options:NSDataWritingAtomic error:nil];
    label.text=[NSString stringWithFormat:@"%@\n\n%@\n%@\n\n%lu cases · %.0f MiB\n%.0f seconds",ALMA_PROBE_TITLE,phase,reason?:@"",(unsigned long)cases.count,mem/1048576.0,CACurrentMediaTime()-began];
}
static void stopTest(NSString *reason) {
    if(atomic_exchange(&stopped,true))return;
    phase=@"stopped";saveStatus(reason);[UIApplication sharedApplication].idleTimerDisabled=NO;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,200*NSEC_PER_MSEC),dispatch_get_main_queue(),^{exit(75);});
}
static void received(const char *message) {
    NSData *data=[[NSData alloc] initWithBytes:message length:strlen(message)];
    NSDictionary *event=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if(!event)return;
    dispatch_async(dispatch_get_main_queue(),^{
        if(atomic_load(&stopped))return;
        NSString *type=event[@"type"];
        if([type isEqualToString:@"phase"]){
            phase=event[@"phase"];phaseBegan=CACurrentMediaTime();phaseDeadline=MIN(195,[event[@"deadlineSeconds"] unsignedIntegerValue]);casePeak=footprint();
        }else if([type isEqualToString:@"case"]){
            NSMutableDictionary *item=[event mutableCopy];item[@"peakAppFootprintBytes"]=@(MAX(casePeak,footprint()));
            [cases addObject:item];
        }else if([type isEqualToString:@"fatal"]){stopTest(event[@"message"]);return;}
        else if([type isEqualToString:@"finished"]){
            summary=event;phase=[event[@"allExpectationsMatched"] boolValue]?@"completed":@"failed";
            atomic_store(&stopped,true);[UIApplication sharedApplication].idleTimerDisabled=NO;
            saveStatus(@"Results saved");
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW,500*NSEC_PER_MSEC),dispatch_get_main_queue(),^{exit(0);});
            return;
        }
        saveStatus(nil);
    });
}
static void beginTest(void) {
    began=phaseBegan=CACurrentMediaTime();cases=[NSMutableArray new];runID=NSUUID.UUID.UUIDString;
    NSArray *args=NSProcessInfo.processInfo.arguments;NSUInteger i=[args indexOfObject:@"--run-id"];
    if(i!=NSNotFound&&i+1<args.count){
        NSString *candidate=args[i+1];NSCharacterSet *allowed=[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"];
        if(candidate.length<80&&[candidate rangeOfCharacterFromSet:allowed.invertedSet].location==NSNotFound)runID=candidate;
    }
    documents=NSSearchPathForDirectoriesInDomains(NSDocumentDirectory,NSUserDomainMask,YES).firstObject;
    NSDictionary *disk=[NSFileManager.defaultManager attributesOfFileSystemForPath:documents error:nil];
    if([disk[NSFileSystemFreeSize] unsignedLongLongValue]<8ULL*1024*1024*1024){stopTest(@"Less than 8 GiB free");return;}
    [UIApplication sharedApplication].idleTimerDisabled=YES;phase=@"preparing";saveStatus(nil);
    NSString *resources=[NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"payload"];
    NSString *runDir=[documents stringByAppendingPathComponent:runID];
    freopen([[documents stringByAppendingPathComponent:[NSString stringWithFormat:@"stderr-%@.log",runID]] fileSystemRepresentation],"w",stderr);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{@autoreleasepool{
        NSError *error=nil;
        BOOL ok=[NSFileManager.defaultManager createDirectoryAtPath:runDir withIntermediateDirectories:NO attributes:nil error:&error];
        for(NSString *name in @[@"fs",@"work"]){
            if(!ok)break;
            ok=[NSFileManager.defaultManager copyItemAtPath:[resources stringByAppendingPathComponent:name] toPath:[runDir stringByAppendingPathComponent:name] error:&error];
        }
        if(!ok){dispatch_async(dispatch_get_main_queue(),^{stopTest(error.localizedDescription);});return;}
        ALMA_PROBE_FUNCTION(resources.fileSystemRepresentation,runDir.fileSystemRepresentation,received);
    }});
    [NSTimer scheduledTimerWithTimeInterval:0.1 repeats:YES block:^(NSTimer *timer){
        if(atomic_load(&stopped)){[timer invalidate];return;}
        saveStatus(nil);
        uint64_t available=os_proc_available_memory();
        if(footprint()>900ULL*1024*1024||(available&&available<180ULL*1024*1024))stopTest(@"Memory guard");
        else if(NSProcessInfo.processInfo.thermalState>=NSProcessInfoThermalStateSerious)stopTest(@"Thermal guard");
        else if(CACurrentMediaTime()-phaseBegan>phaseDeadline||CACurrentMediaTime()-began>600)stopTest(@"Deadline guard");
        else {
            NSString *path=[documents stringByAppendingPathComponent:[NSString stringWithFormat:@"stderr-%@.log",runID]];
            if([[NSFileManager.defaultManager attributesOfItemAtPath:path error:nil][NSFileSize] unsignedLongLongValue]>4*1024*1024)stopTest(@"Log size guard");
        }
    }];
}
@interface Scene : UIResponder <UIWindowSceneDelegate>
@property(strong,nonatomic) UIWindow *window;
@end
@implementation Scene
- (void)scene:(UIScene*)scene willConnectToSession:(UISceneSession*)session options:(UISceneConnectionOptions*)options {
    self.window=[[UIWindow alloc]initWithWindowScene:(UIWindowScene*)scene];UIViewController *vc=[UIViewController new];vc.view.backgroundColor=UIColor.systemBackgroundColor;
    label=[UILabel new];label.numberOfLines=0;label.textAlignment=NSTextAlignmentCenter;label.font=[UIFont preferredFontForTextStyle:UIFontTextStyleBody];label.frame=vc.view.bounds;label.autoresizingMask=UIViewAutoresizingFlexibleWidth|UIViewAutoresizingFlexibleHeight;label.text=[NSString stringWithFormat:@"%@\nReady",ALMA_PROBE_TITLE];[vc.view addSubview:label];self.window.rootViewController=vc;[self.window makeKeyAndVisible];
    if([NSProcessInfo.processInfo.arguments containsObject:@"--run"])dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC),dispatch_get_main_queue(),^{beginTest();});
}
- (void)sceneDidEnterBackground:(UIScene*)scene {if(began&&!atomic_load(&stopped))stopTest(@"App left foreground");}
@end
@interface App : UIResponder <UIApplicationDelegate>
@end
@implementation App
@end
int main(int argc,char **argv){@autoreleasepool{return UIApplicationMain(argc,argv,nil,NSStringFromClass(App.class));}}
