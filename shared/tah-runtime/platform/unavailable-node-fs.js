// FileAuthStorage is imported for emptyAuthRecord, but never instantiated on iOS.
// Credential persistence uses the explicit native Keychain AuthStorage port.
exports.constants = new Proxy({}, {get() {throw new Error('Node filesystem unavailable: use the mobile platform port');}});
