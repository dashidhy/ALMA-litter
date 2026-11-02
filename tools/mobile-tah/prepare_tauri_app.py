"""Native Tauri target over the existing phone TAH core and user container."""
from pathlib import Path
import json,plistlib,subprocess
HERE=Path(__file__).resolve().parent;REPO=HERE.parents[1];APP=REPO/'apps/ios/tah-ui';GEN=APP/'src-tauri/gen/apple';OUT=HERE/'.cache/tauri-app';OUT.mkdir(parents=True,exist_ok=True)
RUST=REPO/'shared/rust-bridge';BIND=RUST/'generated/swift-tauri';LIB=RUST/'target/aarch64-apple-ios/ios-dev/libalma_tah_ui_lib.a'
FS=REPO/'tools/alma-ios-lab/.cache/runtime-rootfs/354d49ec25295e6c/fs'
for p in [GEN/'Sources',FS,BIND/'codex_mobile_client.swift',LIB]:
 if not p.exists():raise RuntimeError(f'Missing real build input: {p}')
native=REPO/'apps/ios/Sources/AlmaTAH'
sources=[*sorted((native/'Runtime').glob('*.swift')),*sorted((native/'Persistence').glob('TAH*.swift')),native/'Presentation/TAHPresentationContract.swift',HERE/'Sources/TauriNativeHost.swift',BIND/'codex_mobile_client.swift']
sources += [REPO/'apps/ios/Sources/Litter/Models'/n for n in ['ChatGPTOAuth.swift','ChatGPTAuthRefreshProvider.swift','LLog.swift']]
info=plistlib.loads((APP/'src-tauri/Info.ios.plist').read_bytes())
info.update({'CFBundleShortVersionString':'0.2.0','CFBundleVersion':'5','LSRequiresIPhoneOS':True,'UILaunchStoryboardName':'LaunchScreen','UIRequiredDeviceCapabilities':['arm64','metal']})
resources=[FS,REPO/'shared/tah-runtime/generated/alma-tah.js',HERE/'.cache/app/mobile-config.json']
settings={'DEVELOPMENT_TEAM':'C6635V7W82','CODE_SIGN_STYLE':'Automatic','SWIFT_VERSION':'5.9','SWIFT_STRICT_CONCURRENCY':'complete','SWIFT_APPROACHABLE_CONCURRENCY':'NO','SWIFT_DEFAULT_ACTOR_ISOLATION':'nonisolated','PRODUCT_BUNDLE_IDENTIFIER':'com.alma.litter.agent-probe','TARGETED_DEVICE_FAMILY':'1','SUPPORTED_PLATFORMS':'iphoneos','SUPPORTS_MACCATALYST':'NO','GENERATE_INFOPLIST_FILE':'NO','HEADER_SEARCH_PATHS':[str(BIND)],'SWIFT_INCLUDE_PATHS':[str(BIND)],'OTHER_LDFLAGS':['$(inherited)',str(LIB),'-lc++','-lz','-lresolv','-lsqlite3'],'DEBUG_INFORMATION_FORMAT':'dwarf','ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES':True,'ASSETCATALOG_COMPILER_APPICON_NAME':'AppIcon'}
target={'type':'application','platform':'iOS','sources':[{'path':str(p)}for p in sources]+[{'path':str(GEN/'Sources')},{'path':str(GEN/'Assets.xcassets')},{'path':str(GEN/'LaunchScreen.storyboard')}]+[{'path':str(p),'buildPhase':'resources',**({'type':'folder'}if p==FS else{})}for p in resources],
 'info':{'path':str(OUT/'Info.plist'),'properties':info},'entitlements':{'path':str(OUT/'AlmaTAHTauri.entitlements'),'properties':{'com.apple.developer.kernel.extended-virtual-addressing':True}},
 'dependencies':[{'sdk':x+'.framework'}for x in ['UIKit','Foundation','JavaScriptCore','CoreFoundation','AuthenticationServices','CryptoKit','Security','Network','SystemConfiguration','CoreGraphics','Metal','MetalKit','QuartzCore','WebKit']]}
spec={'name':'AlmaTAHTauri','options':{'deploymentTarget':{'iOS':'18.0'}},'settings':{'base':settings},'targets':{'AlmaTAHTauri':target},'schemes':{'AlmaTAHTauri':{'build':{'targets':{'AlmaTAHTauri':'all'}},'run':{'config':'Release'}}}}
(OUT/'project.yml').write_text(json.dumps(spec,indent=2)+'\n')
subprocess.run(['xcodegen','generate','--spec',str(OUT/'project.yml'),'--project',str(OUT)],check=True)
print(json.dumps({'project':str(OUT/'AlmaTAHTauri.xcodeproj'),'sourceCount':len(sources),'bundleID':'com.alma.litter.agent-probe','singleRustLibrary':str(LIB)}))
