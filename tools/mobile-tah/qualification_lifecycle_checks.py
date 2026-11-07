"""Exercise the driver's real lifecycle classifier on Mac, without phone/build IO."""
from pathlib import Path
import subprocess
import tempfile

source = Path(__file__).with_name('TAHMobileQualification.swift').read_text()
# Compile the same platform-independent classifier used by the phone driver.
classifier = source.split('enum TAHQualificationAvailability:', 1)[1].split(
    '/// Optional phone-owned runner.', 1)[0]
fixture = '''
import Foundation
@main struct Check {
    static func main() throws {
        typealias A = TAHQualificationAvailability
        // Observed regression: Control Center, protected files still readable.
        let controlCenter = A.classify(protectedDataAvailable: true, applicationIsActive: false)
        precondition(controlCenter == .needs_foreground)
        precondition(controlCenter != .needs_user_unlocked)
        // Returning to the app does not retain a stale lock classification.
        precondition(A.classify(protectedDataAvailable: true, applicationIsActive: true) == .ready)
        // File protection is a separate gate, regardless of application activity.
        for active in [true, false] {
            precondition(A.classify(protectedDataAvailable: false, applicationIsActive: active) == .needs_user_unlocked)
        }
        let encoded = String(decoding: try JSONEncoder().encode(controlCenter), as: UTF8.self)
        precondition(encoded == #""needs_foreground""#)
        print("PASS: inactive is not locked; foreground recovery; protected-data gate; report reason")
    }
}
'''
with tempfile.TemporaryDirectory(prefix='alma-qualification-lifecycle-') as folder:
    root = Path(folder)
    (root / 'Availability.swift').write_text('enum TAHQualificationAvailability:' + classifier)
    (root / 'Check.swift').write_text(fixture)
    subprocess.run(['xcrun', 'swiftc', '-swift-version', '6', '-strict-concurrency=complete',
                    '-warnings-as-errors', '-parse-as-library', '-module-cache-path', str(root / 'cache'),
                    str(root / 'Availability.swift'), str(root / 'Check.swift'),
                    '-o', str(root / 'check')], check=True)
    subprocess.run([str(root / 'check')], check=True)
