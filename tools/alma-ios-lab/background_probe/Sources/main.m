#import <UIKit/UIKit.h>
#import <BackgroundTasks/BackgroundTasks.h>
#import <mach/mach.h>
#import <os/proc.h>
#import <stdatomic.h>
#import <sys/resource.h>

typedef void (*ProbeCallback)(const char *);
extern void alma_ish_background_run(const char *, const char *, uint32_t, uint32_t, ProbeCallback, bool (*)(void));
static NSString *const taskID=@"com.alma.litter.background-probe.work";
static UILabel *label;
static NSString *documents, *runDir, *runID, *mode, *phase=@"ready", *terminalReason=@"";
static NSMutableArray *events;
static BGContinuedProcessingTask *backgroundTask;
static double began;
static uint64_t peak;
static NSUInteger cycles=120, completedCycles, workload;
static atomic_bool stopped;
static BOOL submitted, terminal;

static uint64_t footprint(void) {
    task_vm_info_data_t info={0}; mach_msg_type_number_t n=TASK_VM_INFO_COUNT;
    return task_info(mach_task_self(),TASK_VM_INFO,(task_info_t)&info,&n)==KERN_SUCCESS?info.phys_footprint:0;
}
static void save(void) {
    NSCAssert(NSThread.isMainThread,@"Report state is main-thread owned");
    uint64_t mem=footprint();peak=MAX(peak,mem);
    NSDictionary *disk=[NSFileManager.defaultManager attributesOfFileSystemForPath:documents error:nil];
    NSDictionary *report=@{@"runID":runID?:@"",@"mode":mode?:@"",@"phase":phase,@"workload":@(workload),@"lowPowerMode":@(NSProcessInfo.processInfo.lowPowerModeEnabled),@"build":NSBundle.mainBundle.infoDictionary[@"CFBundleVersion"]?:@"",
        @"reason":terminalReason,@"terminal":@(terminal),@"elapsedSeconds":@(CACurrentMediaTime()-began),
        @"completedCycles":@(completedCycles),@"targetCycles":@(cycles),
        @"footprintBytes":@(mem),@"peakFootprintBytes":@(peak),
        @"availableMemoryBytes":@(os_proc_available_memory()),@"freeDiskBytes":disk[NSFileSystemFreeSize]?:@0,
        @"thermalState":@(NSProcessInfo.processInfo.thermalState),
        @"applicationState":@(UIApplication.sharedApplication.applicationState),
        @"protectedDataAvailable":@(UIApplication.sharedApplication.protectedDataAvailable),
        @"progressCompleted":@(backgroundTask.progress.completedUnitCount),
        @"progressTotal":@(backgroundTask.progress.totalUnitCount),@"events":events?:@[],
        @"scope":@"Release iPhone: actual iSH text processing + native public HTTPS; no Codex account/model. Progress only on completed work."};
    NSData *data=[NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:nil];
    NSDataWritingOptions options=NSDataWritingAtomic|NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication;
    [data writeToFile:[documents stringByAppendingPathComponent:@"background-status.json"] options:options error:nil];
    [data writeToFile:[documents stringByAppendingPathComponent:[NSString stringWithFormat:@"background-%@.json",runID]] options:options error:nil];
    label.text=[NSString stringWithFormat:@"Alma Background Probe\n\n%@ · %@\n%@\n\n%lu/%lu cycles · %.1f MiB\n%.0f seconds",mode,phase,terminalReason,(unsigned long)completedCycles,(unsigned long)cycles,mem/1048576.0,CACurrentMediaTime()-began];
}
static void record(NSDictionary *event) {
    NSCAssert(NSThread.isMainThread,@"Event state is main-thread owned");
    NSMutableDictionary *item=[event mutableCopy];
    item[@"elapsedSeconds"]=@(CACurrentMediaTime()-began);
    item[@"applicationState"]=@(UIApplication.sharedApplication.applicationState);
    item[@"protectedDataAvailable"]=@(UIApplication.sharedApplication.protectedDataAvailable);
    if(events.count<2000)[events addObject:item];
    save();
}
static void finish(BOOL success, NSString *reason) {
    if(terminal)return;
    atomic_store(&stopped,true);terminal=YES;phase=success?@"completed":@"stopped";terminalReason=reason;
    record(@{@"type":@"terminal",@"success":@(success),@"reason":reason});
    [backgroundTask setTaskCompletedWithSuccess:success];
    // Test host must stop a possibly in-flight guest command on task expiry.
    // Whole-process exit is intentionally not presented as production cancellation.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC),dispatch_get_main_queue(),^{exit(success?0:75);});
}
static bool shouldStop(void) {return atomic_load(&stopped);}
static void sleepBounded(NSUInteger seconds) {
    for(NSUInteger i=0;i<seconds*10&&!shouldStop();i++)[NSThread sleepForTimeInterval:0.1];
}
static NSDictionary *httpsSample(void) {
    NSCAssert(!NSThread.isMainThread,@"Network wait must not run on the UI thread");
    double start=CACurrentMediaTime();
    NSURLSessionConfiguration *config=NSURLSessionConfiguration.ephemeralSessionConfiguration;
    config.timeoutIntervalForRequest=20;config.timeoutIntervalForResource=25;
    config.URLCache=nil;config.requestCachePolicy=NSURLRequestReloadIgnoringLocalCacheData;
    NSURLSession *session=[NSURLSession sessionWithConfiguration:config];
    dispatch_semaphore_t done=dispatch_semaphore_create(0);
    __block NSDictionary *result;
    NSObject *resultLock=[NSObject new];
    NSURLSessionDataTask *request=[session dataTaskWithURL:[NSURL URLWithString:@"https://www.apple.com/library/test/success.html"] completionHandler:^(NSData *data,NSURLResponse *response,NSError *error){
        NSInteger code=[response isKindOfClass:NSHTTPURLResponse.class]?[(NSHTTPURLResponse*)response statusCode]:0;
        NSDictionary *receivedResult=@{@"type":@"https",@"status":@(code),@"bytes":@(data.length),@"seconds":@(CACurrentMediaTime()-start),
                 @"passed":@(!error&&code==200&&data.length>0),@"error":error.localizedDescription?:@""};
        @synchronized(resultLock){result=receivedResult;}
        dispatch_semaphore_signal(done);
    }];
    [request resume];
    long waited=dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,27*NSEC_PER_SEC));
    NSDictionary *finalResult;
    if(waited!=0){[request cancel];finalResult=@{@"type":@"https",@"passed":@NO,@"error":@"probe network deadline"};}
    else {@synchronized(resultLock){finalResult=result;}}
    [session invalidateAndCancel];
    return finalResult;
}
static void received(const char *message) {
    @autoreleasepool {
        NSData *data=[NSData dataWithBytes:message length:strlen(message)];
        NSDictionary *event=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        if(!event||shouldStop())return;
        NSString *type=event[@"type"];
        if([type isEqualToString:@"between"]){
            NSUInteger index=[event[@"index"] unsignedIntegerValue];
            if(index%5==0&&!shouldStop()){
                NSDictionary *network=httpsSample();
                dispatch_async(dispatch_get_main_queue(),^{
                    if(terminal)return;
                    record(network);
                    if([network[@"passed"] boolValue])backgroundTask.progress.completedUnitCount++;
                    else finish(NO,@"HTTPS failure");
                });
            }
            NSUInteger wait=5;
            if([mode hasPrefix:@"quiet"]){
                if(index==2)wait=15;
                if(index==5)wait=45;
                if(index==8)wait=120;
            }
            dispatch_async(dispatch_get_main_queue(),^{if(!terminal){phase=@"waiting";record(@{@"type":@"wait",@"seconds":@(wait)});}});
            BOOL uncertain=[mode isEqualToString:@"quiet-indeterminate"]&&wait>5;
            if(uncertain)dispatch_sync(dispatch_get_main_queue(),^{
                if(!terminal){backgroundTask.progress.totalUnitCount=-1;
                    [backgroundTask updateTitle:@"Alma tool test" subtitle:@"Waiting for a response; duration unknown"];
                    record(@{@"type":@"indeterminate-wait-start"});}
            });
            sleepBounded(wait);
            if(uncertain)dispatch_async(dispatch_get_main_queue(),^{
                if(!terminal){backgroundTask.progress.totalUnitCount=2+cycles+(cycles+4)/5;
                    record(@{@"type":@"indeterminate-wait-ended"});}
            });
            return;
        }
        dispatch_async(dispatch_get_main_queue(),^{
            if(terminal)return;
            if([type isEqualToString:@"cycle-start"]){phase=@"guest-running";}
            if([type isEqualToString:@"cycle"]){
                phase=@"processing";completedCycles++;
                if([event[@"passed"] boolValue])backgroundTask.progress.completedUnitCount++;
            }else if([type isEqualToString:@"setup"]){
                phase=event[@"id"];if([event[@"exitCode"] intValue]==0)backgroundTask.progress.completedUnitCount++;
            }
            record(event);
            if([type isEqualToString:@"fatal"])finish(NO,event[@"message"]);
            if([type isEqualToString:@"finished"])finish(completedCycles==cycles&&!shouldStop(),@"guest work ended");
        });
    }
}
static void work(BGContinuedProcessingTask *task) {
    backgroundTask=task;phase=@"preparing";
    task.progress.totalUnitCount=2+cycles+(cycles+4)/5;
    task.expirationHandler=^{atomic_store(&stopped,true);dispatch_async(dispatch_get_main_queue(),^{finish(NO,@"system expiration or user cancellation");});};
    record(@{@"type":@"handler-started"});
    NSString *resources=[NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"payload"];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{@autoreleasepool{
        NSError *error=nil;
        BOOL ok=[NSFileManager.defaultManager createDirectoryAtPath:runDir withIntermediateDirectories:NO
            attributes:@{NSFileProtectionKey:NSFileProtectionCompleteUntilFirstUserAuthentication} error:&error];
        for(NSString *name in @[@"fs",@"work"]){
            if(!ok)break;
            ok=[NSFileManager.defaultManager copyItemAtPath:[resources stringByAppendingPathComponent:name]
                toPath:[runDir stringByAppendingPathComponent:name] error:&error];
        }
        if(!ok){dispatch_async(dispatch_get_main_queue(),^{finish(NO,error.localizedDescription);});return;}
        alma_ish_background_run(resources.fileSystemRepresentation,runDir.fileSystemRepresentation,(uint32_t)cycles,(uint32_t)workload,received,shouldStop);
    }});
}
static void start(void) {
    if(submitted)return;submitted=YES;began=CACurrentMediaTime();events=[NSMutableArray new];
    documents=NSSearchPathForDirectoriesInDomains(NSDocumentDirectory,NSUserDomainMask,YES).firstObject;
    runID=NSUUID.UUID.UUIDString;mode=@"continuous";
    NSArray *args=NSProcessInfo.processInfo.arguments;
    for(NSUInteger i=1;i+1<args.count;i++){
        if([args[i] isEqualToString:@"--mode"]&&[@[@"continuous",@"quiet",@"quiet-indeterminate"] containsObject:args[i+1]])mode=args[i+1];
        if([args[i] isEqualToString:@"--workload"]&&[args[i+1] isEqualToString:@"node"])workload=1;
        if([args[i] isEqualToString:@"--cycles"])cycles=MAX(1,MIN(180,[args[i+1] integerValue]));
        if([args[i] isEqualToString:@"--run-id"]){
            NSString *s=args[i+1];NSCharacterSet *allowed=[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"];
            if(s.length>0&&s.length<80&&[s rangeOfCharacterFromSet:allowed.invertedSet].location==NSNotFound)runID=s;
        }
    }
    runDir=[documents stringByAppendingPathComponent:runID];
    freopen([[documents stringByAppendingPathComponent:[NSString stringWithFormat:@"background-%@.log",runID]] fileSystemRepresentation],"w",stderr);
    [UIApplication sharedApplication].idleTimerDisabled=NO;
    NSDictionary *disk=[NSFileManager.defaultManager attributesOfFileSystemForPath:documents error:nil];
    if([disk[NSFileSystemFreeSize] unsignedLongLongValue]<8ULL*1024*1024*1024){finish(NO,@"storage guard");return;}
    BOOL registered=[BGTaskScheduler.sharedScheduler registerForTaskWithIdentifier:taskID usingQueue:dispatch_get_main_queue() launchHandler:^(BGTask *task){work((BGContinuedProcessingTask*)task);}];
    if(!registered){finish(NO,@"registration rejected");return;}
    phase=@"submitted";record(@{@"type":@"submit",@"os":UIDevice.currentDevice.systemVersion,@"supportedResources":@(BGTaskScheduler.supportedResources)});
    BGContinuedProcessingTaskRequest *request=[[BGContinuedProcessingTaskRequest alloc]initWithIdentifier:taskID title:@"Alma tool test" subtitle:@"Processing text and checking network"];
    request.strategy=BGContinuedProcessingTaskRequestSubmissionStrategyFail;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY,0),^{
        if(@available(iOS 27.0,*)){
            [BGTaskScheduler.sharedScheduler submitTaskRequest:request completionHandler:^(NSError *error){
                dispatch_async(dispatch_get_main_queue(),^{if(error)finish(NO,error.localizedDescription);else record(@{@"type":@"submission-accepted"});});
            }];
        }else{
            NSError *error=nil;BOOL ok=[BGTaskScheduler.sharedScheduler submitTaskRequest:request error:&error];
            dispatch_async(dispatch_get_main_queue(),^{if(!ok)finish(NO,error.localizedDescription?:@"submission failed");});
        }
    });
    [NSTimer scheduledTimerWithTimeInterval:1 repeats:YES block:^(NSTimer *timer){
        if(terminal){[timer invalidate];return;}peak=MAX(peak,footprint());
        uint64_t available=os_proc_available_memory();
        if(footprint()>900ULL*1024*1024||(available&&available<180ULL*1024*1024))finish(NO,@"memory guard");
        else if(NSProcessInfo.processInfo.thermalState>=NSProcessInfoThermalStateSerious)finish(NO,@"thermal guard");
        else if(CACurrentMediaTime()-began>2100)finish(NO,@"35 minute probe deadline");
        else if(!backgroundTask&&CACurrentMediaTime()-began>60)finish(NO,@"handler did not start");
        else {
            static NSUInteger ticks;
            ticks++;
            if(ticks%5==0){
                struct rusage usage={0};getrusage(RUSAGE_SELF,&usage);
                double cpu=usage.ru_utime.tv_sec+usage.ru_utime.tv_usec/1e6+usage.ru_stime.tv_sec+usage.ru_stime.tv_usec/1e6;
                record(@{@"type":@"liveness",@"appCpuSeconds":@(cpu)});
                NSString *path=[documents stringByAppendingPathComponent:[NSString stringWithFormat:@"background-%@.log",runID]];
                if([[NSFileManager.defaultManager attributesOfItemAtPath:path error:nil][NSFileSize] unsignedLongLongValue]>16*1024*1024)finish(NO,@"log size guard");
            }
        } // Liveness reporting does not advance BGTask progress.
    }];
}
@interface Scene : UIResponder <UIWindowSceneDelegate>
@property(strong,nonatomic) UIWindow *window;
@end
@implementation Scene
- (void)scene:(UIScene*)scene willConnectToSession:(UISceneSession*)session options:(UISceneConnectionOptions*)options {
    self.window=[[UIWindow alloc]initWithWindowScene:(UIWindowScene*)scene];UIViewController *vc=[UIViewController new];vc.view.backgroundColor=UIColor.systemBackgroundColor;
    label=[UILabel new];label.numberOfLines=0;label.textAlignment=NSTextAlignmentCenter;label.frame=CGRectMake(10,80,self.window.bounds.size.width-20,420);label.text=@"Alma Background Probe\nReady";
    UIButton *button=[UIButton buttonWithType:UIButtonTypeSystem];button.frame=CGRectMake(40,540,self.window.bounds.size.width-80,60);[button setTitle:@"Start test" forState:UIControlStateNormal];[button addTarget:self action:@selector(startPressed) forControlEvents:UIControlEventTouchUpInside];
    [vc.view addSubview:label];[vc.view addSubview:button];self.window.rootViewController=vc;[self.window makeKeyAndVisible];
    if([NSProcessInfo.processInfo.arguments containsObject:@"--run"])dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC),dispatch_get_main_queue(),^{start();});
}
- (void)startPressed {start();}
- (void)sceneDidEnterBackground:(UIScene*)scene {if(submitted&&!terminal)record(@{@"type":@"entered-background"});}
- (void)sceneDidBecomeActive:(UIScene*)scene {if(submitted&&!terminal)record(@{@"type":@"became-active"});}
@end
@interface App : UIResponder <UIApplicationDelegate>
@end
@implementation App
- (void)applicationProtectedDataWillBecomeUnavailable:(UIApplication*)app {if(submitted&&!terminal)record(@{@"type":@"protected-data-locking"});}
- (void)applicationProtectedDataDidBecomeAvailable:(UIApplication*)app {if(submitted&&!terminal)record(@{@"type":@"protected-data-unlocked"});}
@end
int main(int argc,char **argv){@autoreleasepool{return UIApplicationMain(argc,argv,nil,NSStringFromClass(App.class));}}
