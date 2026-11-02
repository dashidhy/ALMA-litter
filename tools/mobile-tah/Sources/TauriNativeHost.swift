import Foundation
import Observation
import UIKit

public typealias TAHUIChanged = @convention(c) () -> Void
public typealias TAHUIWorkingSend = @convention(c) (UInt64, UInt64, UnsafePointer<CChar>?) -> Bool

@_cdecl("alma_tah_ui_set_working_callback")
public func almaTAHUISetWorkingCallback(_ callback: TAHUIWorkingSend?) {
    Task { @MainActor in TauriTAHService.shared.setWorkingCallback(callback) }
}
@_cdecl("alma_tah_ui_working_subscribe")
public func almaTAHUIWorkingSubscribe(_ id: UInt64) {
    Task { @MainActor in TauriTAHService.shared.subscribeWorking(id) }
}
@_cdecl("alma_tah_ui_working_ack")
public func almaTAHUIWorkingACK(_ id: UInt64, _ sequence: UInt64) {
    Task { @MainActor in TauriTAHService.shared.acknowledgeWorking(id, sequence: sequence) }
}
@_cdecl("alma_tah_ui_working_unsubscribe")
public func almaTAHUIWorkingUnsubscribe(_ id: UInt64) {
    Task { @MainActor in TauriTAHService.shared.unsubscribeWorking(id) }
}

@_cdecl("alma_tah_ui_set_changed_callback")
public func almaTAHUISetChangedCallback(_ changed: TAHUIChanged?) {
    Task { @MainActor in TauriTAHService.shared.setChangedCallback(changed) }
}

public typealias TAHUIReply = @convention(c) (UInt64, UnsafePointer<CChar>?, UnsafePointer<CChar>?) -> Void

@_cdecl("alma_tah_prepare_process")
public func almaTAHPrepareProcess() -> Bool {
    do {
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        try initializeMobileTahProcess(applicationSupport: support.path)
        return true
    } catch { return false }
}

@_cdecl("alma_tah_ui_call")
public func almaTAHUICall(_ id: UInt64, _ input: UnsafePointer<CChar>?, _ reply: @escaping TAHUIReply) {
    guard let input else { "invalid_request".withCString { reply(id, nil, $0) }; return }
    let request = String(cString: input)
    Task { @MainActor in
        do {
            let result = try await TauriTAHService.shared.call(request)
            result.withCString { reply(id, $0, nil) }
        } catch {
            // Never serialize native/provider errors or credential-bearing data.
            "ui_request_failed".withCString { reply(id, nil, $0) }
        }
    }
}

@MainActor private final class TauriTAHService: NSObject {
    static let shared = TauriTAHService()
    private var controller: TAHMobileController?
    private var platform: TAHCodexPlatform?
    private var bridge: TAHWebPresentationBridge?
    private var starting = false
    private var failure: String?
    private var changed: TAHUIChanged?
    private var observationGeneration = UUID()
    private var lifecycleRefreshScheduled = false
    private var workingCallback: TAHUIWorkingSend?
    private var workingSubscription: UInt64?
    private var highestWorkingSubscription: UInt64 = 0
    private var workingReady = false
    private lazy var workingChannel: TAHWorkingLogChannel = TAHWorkingLogChannel(send: { [weak self] id, sequence, json in
        guard let self, self.workingSubscription == id, let callback = self.workingCallback else { return false }
        return json.withCString { callback(id, sequence, $0) }
    }, readiness: { [weak self] ready in
        guard let self else { return }
        self.workingReady = ready; self.controller?.setWorkingConsumerReady(ready)
    })

    func setWorkingCallback(_ callback: TAHUIWorkingSend?) {
        workingCallback = callback
        if callback == nil, let id = workingSubscription { unsubscribeWorking(id) }
        else if callback != nil, let id = workingSubscription { workingChannel.subscribe(id, value: controller?.presentation.workingLog) }
    }
    func subscribeWorking(_ id: UInt64) {
        guard id > highestWorkingSubscription else { return }
        highestWorkingSubscription = id
        workingSubscription = id; workingReady = false
        controller?.setWorkingChannelEnabled(true)
        if workingCallback != nil { workingChannel.subscribe(id, value: controller?.presentation.workingLog) }
    }
    func acknowledgeWorking(_ id: UInt64, sequence: UInt64) { workingChannel.acknowledge(id, sequence: sequence) }
    func unsubscribeWorking(_ id: UInt64) {
        guard workingSubscription == id else { return }
        workingChannel.unsubscribe(id); workingSubscription = nil; workingReady = false
        controller?.setWorkingChannelEnabled(false)
    }

    func setChangedCallback(_ callback: TAHUIChanged?) {
        observationGeneration = UUID()
        changed = callback
        NotificationCenter.default.removeObserver(self)
        guard callback != nil else { return }
        observeProjection()
        // Only the host integrates UIKit lifecycle; the controller owns Core events.
        for name in [UIApplication.didBecomeActiveNotification, UIApplication.significantTimeChangeNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(lifecycleChanged), name: name, object: nil)
        }
    }

    private func observeProjection() {
        guard let controller, changed != nil else { return }
        let generation = observationGeneration
        withObservationTracking {
            _ = controller.presentation
            _ = controller.draft
        } onChange: { [weak self] in
            // Observation fires before mutation. Re-arm and notify on the next
            // main-actor turn, after synchronous presentation/draft writes finish.
            Task { @MainActor [weak self] in
                guard let self, self.observationGeneration == generation, self.changed != nil else { return }
                self.observeProjection()
                self.changed?()
            }
        }
    }

    @objc nonisolated private func lifecycleChanged() {
        Task { @MainActor [weak self] in self?.scheduleLifecycleRefresh() }
    }

    private func scheduleLifecycleRefresh() {
        guard changed != nil, !lifecycleRefreshScheduled else { return }
        lifecycleRefreshScheduled = true
        let generation = observationGeneration
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.lifecycleRefreshScheduled = false
            guard self.observationGeneration == generation, self.changed != nil else { return }
            if let controller = self.controller { controller.refresh() }
            else { self.startIfNeeded() }
        }
    }

    func call(_ text: String) async throws -> String {
        struct Request: Decodable { let method: String; let value: TAHRuntimeValue }
        let request = try JSONDecoder().decode(Request.self, from: Data(text.utf8))
        if request.method == "snapshot" {
            startIfNeeded()
            if let bridge { return try await bridge.snapshot() }
            return try pendingSnapshot()
        }
        if request.method == "refresh", bridge == nil {
            failure = nil
            startIfNeeded()
            return try pendingSnapshot()
        }
        if request.method == "signIn" {
            guard !starting, controller == nil else { throw TAHRuntimeError.busy }
            starting = true
            Task { @MainActor in
                defer {
                    starting = false
                    changed?()
                    if failure == nil { startIfNeeded() }
                }
                do { _ = try await ChatGPTOAuth.login(); failure = nil }
                catch { failure = "Sign-in did not complete. Please try again." }
            }
            return try pendingSnapshot()
        }
        if request.method == "openExternal" {
            guard let address = try request.value["url"]?.string(), let url = URL(string: address),
                  ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host != nil,
                  url.user == nil, url.password == nil else { throw TAHRuntimeError.invalid_request }
            await UIApplication.shared.open(url)
            if let bridge { return try await bridge.snapshot() }
            return try pendingSnapshot()
        }
        guard let bridge else { throw TAHRuntimeError.unavailable }
        let value = String(decoding: try JSONEncoder().encode(request.value), as: UTF8.self)
        return try await bridge.dispatch(method: request.method, valueJSON: value)
    }

    private func startIfNeeded() {
        guard controller == nil, !starting, failure == nil else { return }
        starting = true
        Task { @MainActor in
            defer { starting = false; changed?() }
            do {
                guard let fs = Bundle.main.url(forResource: "fs", withExtension: nil),
                      let js = Bundle.main.url(forResource: "alma-tah", withExtension: "js"),
                      let config = Bundle.main.url(forResource: "mobile-config", withExtension: "json") else { throw TAHRuntimeError.unavailable }
                let supplied = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                let support = URL(fileURLWithPath: try TAHRuntimeResources.canonicalPath(supplied.path), isDirectory: true)
                let native = try await TAHCodexPlatform(bundleFS: fs, support: support)
                platform = native
                let core = try await TAHMobileController(bundleURL: js, configurationJSON: String(contentsOf: config, encoding: .utf8),
                    journalDirectory: support.appendingPathComponent("mobile-tah-journal")) { method, json in try await native.call(method, json: json) }
                controller = core
                core.workingLogDidChange = { [weak self] value in self?.workingChannel.update(value) }
                core.setWorkingChannelEnabled(workingSubscription != nil)
                core.setWorkingConsumerReady(workingReady)
                bridge = TAHWebPresentationBridge(controller: core)
                workingChannel.update(core.presentation.workingLog)
                observeProjection()
                diagnostic("ready")
            } catch {
                failure = "Could not prepare TAH. Check your ChatGPT sign-in and reopen the app."
                diagnostic("preparation_failed")
            }
        }
    }

    private func pendingSnapshot() throws -> String {
        let permissions = ["selectTranscript", "importTranscript", "selectAction", "checkRaw", "createAction", "edit", "editConsent", "editInteractionLanguage", "send", "readMaterial", "loadHistory"]
        let state: [String: Any] = ["transcripts": [], "transcriptID": NSNull(), "actions": [], "editor": NSNull(), "models": [], "efforts": [], "contextWindows": [], "interactionLanguage": "en",
            "initialSettingsFrozen": true, "canOmitInstructions": false, "consentGranted": false, "rawStatus": "", "rawExplanation": NSNull(), "rawValidityLabel": NSNull(),
            "status": starting ? "preparing" : "", "disabledReason": NSNull(), "error": failure as Any? ?? NSNull(), "isBusy": starting, "timeline": [], "revisions": [], "hasMoreHistory": false,
            "material": NSNull(), "permissions": Dictionary(uniqueKeysWithValues: permissions.map { ($0, false) })]
        let draft: [String: Any] = ["outputLanguage": "en", "settings": ["providerID": NSNull(), "modelID": NSNull(), "reasoningEffortID": NSNull(), "contextWindowTokens": NSNull(), "webEnabled": false], "instructions": "", "consent": false]
        return String(decoding: try JSONSerialization.data(withJSONObject: ["presentation": state, "draft": draft, "ready": false, "error": failure as Any? ?? NSNull()]), as: UTF8.self)
    }

    private func diagnostic(_ phase: String) {
        guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        let data = try? JSONSerialization.data(withJSONObject: ["phase": phase, "frontend": "tauri", "at": ISO8601DateFormatter().string(from: Date())])
        try? data?.write(to: documents.appendingPathComponent("mobile-tah-ui-status.json"), options: .atomic)
    }
}
