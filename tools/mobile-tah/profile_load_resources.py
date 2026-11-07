"""Create disposable load-timing overlays without modifying verified inputs."""
from pathlib import Path
import hashlib
import json
import shutil


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def once(text, old, new):
    if text.count(old) != 1:
        raise ValueError('Profile injection anchor differs from reviewed guest')
    return text.replace(old, new, 1)


def prepare(source: Path, provider: str, output: Path):
    manifest = json.loads((source / 'runtime-manifest.json').read_text())
    for row in manifest['files']:
        file = source / row['path']
        if file.is_symlink() or file.stat().st_size != row['bytes'] or digest(file) != row['sha256']:
            raise ValueError('Profile source identity differs')
    source_sha = digest(source / 'runtime-manifest.json')
    target = output / provider / (provider + '-runtime')
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target)
    # 只放开诊断副本；已验收的只读运行包仍保持原样。
    guest = target / ('guest.mjs' if provider == 'kimi' else 'guest.cjs')
    guest.chmod(0o644)
    (target / 'runtime-manifest.json').chmod(0o644)
    text = guest.read_text()
    if provider == 'kimi':
        text = once(text, 'let terminalSent = false;', 'let profileSDKMs = null;\nlet terminalSent = false;')
        text = once(text, "if (frame.kind === 'terminal') terminalSent = true;", """if (frame.kind === 'terminal') {
    terminalSent = true;
    frame = { ...frame, terminal: { ...frame.terminal, almaLoadTiming: {
      cacheStatus: preparedCache.reason, preparationMs: preparedCache.validationMs,
      sdkLoadMs: profileSDKMs, totalMs: profileSDKMs === null ? null : preparedCache.validationMs + profileSDKMs,
    } } };
  }""")
        text = once(text, "const sdk = await import(new URL('./sdk/index.mjs', import.meta.url).href);",
                    "const sdk = await import(new URL('./sdk/index.mjs', import.meta.url).href);\n    profileSDKMs = performance.now() - started;")
    elif provider == 'zcode':
        text = once(text, "let phase = 'admission';", "let phase = 'admission';\n  let profileLoad = null;")
        text = once(text, "process.stderr.write(JSON.stringify({ type: 'sdk-cache', status: loaded.status,", "profileLoad = { cacheStatus: loaded.status, preparationMs: loaded.preparationMs, sdkLoadMs: loaded.sdkLoadMs, totalMs: loaded.totalMs };\n    process.stderr.write(JSON.stringify({ type: 'sdk-cache', status: loaded.status,")
        text = once(text, 'terminal: { outcome, sessionId, response, sdkClosed }',
                    'terminal: { outcome, sessionId, response, sdkClosed, almaLoadTiming: profileLoad }')
    else:
        raise ValueError('Unsupported profile provider')
    guest.write_text(text)
    for row in manifest['files']:
        file = target / row['path']
        row.update(bytes=file.stat().st_size, sha256=digest(file))
    (target / 'runtime-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    receipt = {'measurementOnly': True, 'provider': provider, 'sourceManifestSHA256': source_sha,
               'manifestSHA256': digest(target / 'runtime-manifest.json'), 'modifiedFiles': [guest.name]}
    (target.parent / 'profile-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return target
