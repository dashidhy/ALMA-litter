"""Native Tauri target over the existing phone TAH core and user container."""
from pathlib import Path
import argparse,json,plistlib,subprocess,sys
from provider_sources import (APP_VERSION, APP_BUILD, provider_sources, prepare_provider_resources,
                              write_build_identity, digest, prepare_zcode_runtime, verify_native_provenance)
HERE=Path(__file__).resolve().parent;REPO=HERE.parents[1];APP=REPO/'apps/ios/tah-ui';GEN=APP/'src-tauri/gen/apple';OUT=HERE/'.cache/tauri-app';OUT.mkdir(parents=True,exist_ok=True)
parser=argparse.ArgumentParser();parser.add_argument('--resources-only',action='store_true');parser.add_argument('--load-profile',action='store_true');parser.add_argument('--long-fixture',type=Path);args=parser.parse_args()
rootfs_manifest,kimi_runtime=prepare_provider_resources()
FS=Path(json.loads(rootfs_manifest.read_text())['fs'])
zcode_runtime=prepare_zcode_runtime()
subprocess.run([sys.executable,str(HERE/'prepare_app.py'),'--config-only'],check=True,cwd=REPO)
identity=write_build_identity(rootfs_manifest,kimi_runtime)
core=Path(provider_sources()['tahRuntime'])
if args.resources_only:
 print(json.dumps({'kimiRuntime':str(kimi_runtime),'rootfsManifest':str(rootfs_manifest),'rootfs':str(FS),'configuration':str(HERE/'.cache/app/mobile-config.json'),'providerBuildIdentity':str(identity),'appVersion':APP_VERSION,'appBuild':APP_BUILD}));sys.exit(0)
RUST=REPO/'shared/rust-bridge';BIND=RUST/'generated/swift-tauri';LIB=RUST/'target/aarch64-apple-ios/ios-dev/libalma_tah_ui_lib.a'
native_identity=HERE/'.cache/app/native-build-identity.json'
for p in [GEN/'Sources',FS,BIND/'codex_mobile_client.swift',LIB,native_identity]:
 if not p.exists():raise RuntimeError(f'Missing real build input: {p}')
native_record=json.loads(native_identity.read_text())
if native_record['artifact']['sha256']!=digest(LIB):raise RuntimeError('Native build identity differs from the Tauri library; rerun build_tauri.py')
verify_native_provenance(native_record)
native=REPO/'apps/ios/Sources/AlmaTAH'
sources=[*sorted((native/'Runtime').glob('*.swift')),*sorted((native/'Persistence').glob('TAH*.swift')),native/'Presentation/TAHPresentationContract.swift',HERE/'Sources/TauriNativeHost.swift',BIND/'codex_mobile_client.swift']
sources += [REPO/'apps/ios/Sources/Litter/Models'/n for n in ['ChatGPTOAuth.swift','ChatGPTAuthRefreshProvider.swift','LLog.swift']]
sources += [HERE/'TAHMobileQualification.swift']
info=plistlib.loads((APP/'src-tauri/Info.ios.plist').read_bytes())
info.update({'CFBundleShortVersionString':APP_VERSION,'CFBundleVersion':APP_BUILD,'LSRequiresIPhoneOS':True,'UILaunchStoryboardName':'LaunchScreen','UIRequiredDeviceCapabilities':['arm64','metal']})
if args.load_profile:
 from profile_load_resources import prepare
 profile=HERE/'.cache/load-profile-resources'
 kimi_runtime=prepare(kimi_runtime,'kimi',profile)
 zcode_runtime=prepare(zcode_runtime,'zcode',profile)
 info['ALMALoadProfile']=True
resources=[FS,kimi_runtime,zcode_runtime,core/'generated/bundle-manifest.json',*sorted((core/'generated').glob('alma-provider-*.js')),core/'generated/alma-tah.js',HERE/'.cache/app/mobile-config.json',identity,native_identity]
resources += [HERE/'fixtures/mobile-qualification-fixture.json']
if args.long_fixture:
 fixture=args.long_fixture.resolve(strict=True)
 if fixture.name != 'mobile-qualification-nvidia.json' or fixture.stat().st_size > 1024*1024: raise ValueError('Invalid long fixture resource')
 resources += [fixture]
settings={'DEVELOPMENT_TEAM':'C6635V7W82','CODE_SIGN_STYLE':'Automatic','SWIFT_VERSION':'5.9','SWIFT_STRICT_CONCURRENCY':'complete','SWIFT_APPROACHABLE_CONCURRENCY':'NO','SWIFT_DEFAULT_ACTOR_ISOLATION':'nonisolated','PRODUCT_BUNDLE_IDENTIFIER':'com.alma.litter.agent-probe','TARGETED_DEVICE_FAMILY':'1','SUPPORTED_PLATFORMS':'iphoneos','SUPPORTS_MACCATALYST':'NO','GENERATE_INFOPLIST_FILE':'NO','HEADER_SEARCH_PATHS':[str(BIND)],'SWIFT_INCLUDE_PATHS':[str(BIND)],'OTHER_LDFLAGS':['$(inherited)',str(LIB),'-lc++','-lz','-lresolv','-lsqlite3'],'DEBUG_INFORMATION_FORMAT':'dwarf','ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES':True,'ASSETCATALOG_COMPILER_APPICON_NAME':'AppIcon'}
target={'type':'application','platform':'iOS','sources':[{'path':str(p)}for p in sources]+[{'path':str(GEN/'Sources')},{'path':str(GEN/'Assets.xcassets')},{'path':str(GEN/'LaunchScreen.storyboard')}]+[{'path':str(p),'buildPhase':'resources',**({'type':'folder'}if p in (FS,kimi_runtime,zcode_runtime) else{})}for p in resources],
 'info':{'path':str(OUT/'Info.plist'),'properties':info},'entitlements':{'path':str(OUT/'AlmaTAHTauri.entitlements'),'properties':{'com.apple.developer.kernel.extended-virtual-addressing':True}},
 'dependencies':[{'sdk':x+'.framework'}for x in ['UIKit','Foundation','JavaScriptCore','CoreFoundation','AuthenticationServices','SafariServices','CryptoKit','Security','Network','SystemConfiguration','CoreGraphics','Metal','MetalKit','QuartzCore','WebKit']]}
spec={'name':'AlmaTAHTauri','options':{'deploymentTarget':{'iOS':'18.0'}},'settings':{'base':settings},'targets':{'AlmaTAHTauri':target},'schemes':{'AlmaTAHTauri':{'build':{'targets':{'AlmaTAHTauri':'all'}},'run':{'config':'Release'}}}}
(OUT/'project.yml').write_text(json.dumps(spec,indent=2)+'\n')
subprocess.run(['xcodegen','generate','--spec',str(OUT/'project.yml'),'--project',str(OUT)],check=True)
print(json.dumps({'project':str(OUT/'AlmaTAHTauri.xcodeproj'),'sourceCount':len(sources),'bundleID':'com.alma.litter.agent-probe','singleRustLibrary':str(LIB)}))
