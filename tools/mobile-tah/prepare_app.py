"""Reproducible standalone phone host; no model calls, installation or credentials."""
from pathlib import Path
import argparse,json,hashlib,subprocess,sys
from provider_sources import (APP_VERSION, APP_BUILD, provider_sources, prepare_runtime,
                              prepare_provider_resources, write_build_identity, prepare_zcode_runtime)
parser=argparse.ArgumentParser();parser.add_argument('--fixture',type=Path);parser.add_argument('--config-only',action='store_true',help='Generate owned Tauri configuration without the legacy SwiftUI library/project');args=parser.parse_args()
if args.config_only and args.fixture:parser.error('--fixture applies only to the standalone SwiftUI host')
HERE=Path(__file__).resolve().parent;REPO=HERE.parents[1];OUT=HERE/'.cache/app';OUT.mkdir(parents=True,exist_ok=True)
inputs=provider_sources()
CORE=Path(inputs['tahRuntime']);RUST=REPO/'shared/rust-bridge';LIB=RUST/'target/aarch64-apple-ios/ios-dev/libcodex_mobile_client.a';BIND=RUST/'generated/swift'
subprocess.run(['node',str(HERE/'build_bundle.mjs')],check=True,cwd=REPO)
rootfs_manifest, kimi_runtime = (None, prepare_runtime()) if args.config_only else prepare_provider_resources()
FS = None if args.config_only else Path(json.loads(rootfs_manifest.read_text())['fs'])
for f in ([] if args.config_only else [LIB,BIND/'codex_mobile_client.swift',CORE/'generated/alma-tah.js',FS]):
 if not f.exists():raise RuntimeError(f'Missing actual build input: {f}')
codex=inputs['providers']['codex']
profile=json.loads((Path(codex['adapter'])/'upstream/providers/codex/app-profile.json').read_text())
profile['profileIdentity']=hashlib.sha256(json.dumps({'baseline':codex['release'],'adapter':(Path(codex['adapter'])/'platform/codex/mobile-provider.ts').read_text(),'source':json.loads((CORE/'source-lock.json').read_text())['files']},sort_keys=True).encode()).hexdigest()
kimi_profile=json.loads((kimi_runtime/'app-profile.json').read_text())
zcode_runtime=prepare_zcode_runtime()
catalog=json.loads((zcode_runtime/'catalog.json').read_text())
models=catalog['models']
guardian=next((model for model in models if model['handle']=='GLM-5.3'),None)
if not guardian or not any(e['handle']=='low' for e in guardian['efforts']):raise ValueError('Qualified ZCode Guardian model is absent')
zcode_profile={'id':'zcode','displayName':'ZCode','authRouteID':'native-zcode-auth','taskRouteID':'native-zcode-task',
 'guardianModel':guardian['handle'],'guardianEffort':'low','disabledModels':[],
 'allowedModels':[model['handle']for model in models],
 'profileIdentity':hashlib.sha256((zcode_runtime/'runtime-manifest.json').read_bytes()).hexdigest()}
prompts=CORE/'upstream/prompts'
resources={key:(prompts/'system_prompts'/name).read_text() for key,name in {'actorPromptTemplate':'actor_prompt_v4_2.txt','rawGuardianPrompt':'safety_guardian_raw_prompt_v0_3.txt','extraGuardianPrompt':'safety_guardian_extra_prompt_v0_6.txt','safetyPolicy':'safety_guardian_policy_v0_2.txt'}.items()}
config=OUT/'mobile-config.json';config.write_text(json.dumps({'profiles':[profile,kimi_profile,zcode_profile],'resources':resources,'actionInstructions':(prompts/'action_instructions/structured_notes_v4_3.txt').read_text()}))
identity=write_build_identity(rootfs_manifest,kimi_runtime)
if args.config_only:
 print(json.dumps({'configuration':str(config),'providerBuildIdentity':str(identity),'standaloneLibraryRequired':False,'phoneRun':False}));sys.exit(0)
fixture=json.loads((REPO/'tools/alma-ios-lab/tah_fixture_pack/manifest.json').read_text())['synthetic_fixture']
fixture_path=OUT/'mobile-qualification-fixture.json'
if args.fixture:
 if args.fixture.stat().st_size>32*1024*1024:raise RuntimeError('Fixture too large')
 chosen=json.loads(args.fixture.read_text())
 if not isinstance(chosen.get('transcript'),str) or len(chosen.get('deltas',[]))!=3:raise RuntimeError('Invalid fixture')
 fixture_path.write_text(json.dumps(chosen,ensure_ascii=False))
else:fixture_path.write_text(json.dumps({'title':'Phone TAH qualification','transcript':fixture['raw_transcript_utf8'],'deltas':[v['text'] for v in fixture['revision_instruction_deltas']]}))
sources=sorted((REPO/'apps/ios/Sources/AlmaTAH').rglob('*.swift'))+sorted((HERE/'Sources').glob('*.swift'))
if (HERE/'TAHMobileQualification.swift').exists():sources.append(HERE/'TAHMobileQualification.swift')
sources += [REPO/'apps/ios/Sources/Litter/Models'/name for name in ['ChatGPTOAuth.swift','ChatGPTAuthRefreshProvider.swift','LLog.swift']]+[BIND/'codex_mobile_client.swift']
settings={'DEVELOPMENT_TEAM':'C6635V7W82','CODE_SIGN_STYLE':'Automatic','SWIFT_VERSION':'5.9','SWIFT_STRICT_CONCURRENCY':'complete','SWIFT_APPROACHABLE_CONCURRENCY':'NO','SWIFT_DEFAULT_ACTOR_ISOLATION':'nonisolated','PRODUCT_BUNDLE_IDENTIFIER':'com.alma.litter.agent-probe','TARGETED_DEVICE_FAMILY':'1','SUPPORTED_PLATFORMS':'iphoneos','SUPPORTS_MACCATALYST':'NO','GENERATE_INFOPLIST_FILE':'NO','HEADER_SEARCH_PATHS':[str(BIND)],'SWIFT_INCLUDE_PATHS':[str(BIND)],'OTHER_LDFLAGS':['$(inherited)',str(LIB),'-lc++','-lz','-lresolv','-lsqlite3'],'DEBUG_INFORMATION_FORMAT':'dwarf'}
spec={'name':'ALMAMobileTAH','options':{'deploymentTarget':{'iOS':'18.0'}},'settings':{'base':settings},'targets':{'ALMAMobileTAH':{'type':'application','platform':'iOS','sources':[{'path':str(p)} for p in sources]+[{'path':str(p),'buildPhase':'resources',**({'type':'folder'} if p in (FS,kimi_runtime,zcode_runtime) else {})}for p in [FS,kimi_runtime,zcode_runtime,CORE/'generated/alma-tah.js',CORE/'generated/bundle-manifest.json',*sorted((CORE/'generated').glob('alma-provider-*.js')),config,identity,fixture_path]],'info':{'path':str(OUT/'Info.plist'),'properties':{'CFBundleDisplayName':'ALMA TAH','CFBundleShortVersionString':APP_VERSION,'CFBundleVersion':APP_BUILD,'UILaunchScreen':{},'UIApplicationSceneManifest':{'UIApplicationSupportsMultipleScenes':False},'UISupportedInterfaceOrientations':['UIInterfaceOrientationPortrait'],'NSLocalNetworkUsageDescription':'Complete your ChatGPT sign-in.','NSAppTransportSecurity':{'NSAllowsLocalNetworking':True}}},'entitlements':{'path':str(OUT/'ALMAMobileTAH.entitlements'),'properties':{'com.apple.developer.kernel.extended-virtual-addressing':True}},'dependencies':[{'sdk':x+'.framework'}for x in ['SwiftUI','UIKit','Foundation','JavaScriptCore','CoreFoundation','AuthenticationServices','SafariServices','CryptoKit','Security','Network','SystemConfiguration']]}},'schemes':{'ALMAMobileTAH':{'build':{'targets':{'ALMAMobileTAH':'all'}},'run':{'config':'Release'}}}}
(OUT/'project.yml').write_text(json.dumps(spec,indent=2)+'\n')
subprocess.run(['xcodegen','generate','--spec',str(OUT/'project.yml'),'--project',str(OUT)],check=True,cwd=REPO)
print(json.dumps({'project':str(OUT/'ALMAMobileTAH.xcodeproj'),'sourceCount':len(sources),'bundleID':settings['PRODUCT_BUNDLE_IDENTIFIER'],'phoneRun':False}))
