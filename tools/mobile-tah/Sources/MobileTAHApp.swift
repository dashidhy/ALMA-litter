import Foundation
import SwiftUI
import UIKit

@main struct MobileTAHApp: App {
    init() {
        // Configure the immutable native TLS/client identity before constructing
        // AppClient, the Tokio runtime or any provider/network client.
        do {
            let support=try FileManager.default.url(for:.applicationSupportDirectory,in:.userDomainMask,appropriateFor:nil,create:true)
            try initializeMobileTahProcess(applicationSupport:support.path)
        } catch { MobileTAHStartup.failed = true }
    }
    var body: some Scene { WindowGroup { MobileTAHRoot() } }
}

@MainActor private enum MobileTAHStartup { static var failed = false }

@MainActor struct MobileTAHRoot: View {
    @State private var controller: TAHMobileController?
    @State private var platform: TAHCodexPlatform?
    @State private var preparing = false
    @State private var message = "Connect your ChatGPT account, then open Structured Notes."

    var body: some View {
        NavigationStack {
            if let controller { TAHMobileView(controller: controller) }
            else {
                Form {
                    Section("Local TAH") {
                        Text(message)
                        if preparing { ProgressView("Preparing") }
                        Button("Open Structured Notes") { Task { await prepare() } }.disabled(preparing)
                        Button("Sign in with ChatGPT") { Task {
                            preparing = true
                            do { _ = try await ChatGPTOAuth.login(); message = "Account ready. Open Structured Notes." }
                            catch { message = "Sign-in did not complete. Try again." }
                            preparing = false
                        } }.disabled(preparing)
                    }
                }.navigationTitle("ALMA TAH")
            }
        }
        .task {
            if ProcessInfo.processInfo.arguments.contains("--mobile-tah-qualification")
                || ProcessInfo.processInfo.arguments.contains("--mobile-tah-open")
                || ProcessInfo.processInfo.arguments.contains("--mobile-tah-import") { await prepare() }
        }
    }

    private func prepare() async {
        guard !preparing, controller == nil else { return }
        preparing = true
        defer { preparing = false }
        do {
            guard !MobileTAHStartup.failed else { throw TAHRuntimeError.unavailable }
            guard let fs = Bundle.main.url(forResource: "fs", withExtension: nil),
                  let js = Bundle.main.url(forResource: "alma-tah", withExtension: "js"),
                  let configURL = Bundle.main.url(forResource: "mobile-config", withExtension: "json") else { throw TAHRuntimeError.unavailable }
            let suppliedSupport = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let support = URL(fileURLWithPath: try TAHRuntimeResources.canonicalPath(suppliedSupport.path), isDirectory: true)
            let native = try await TAHCodexPlatform(bundleFS: fs, support: support)
            platform = native
            let config = try String(contentsOf: configURL, encoding: .utf8)
            let app = try await TAHMobileController(bundleURL: js, configurationJSON: config,
                journalDirectory: support.appendingPathComponent("mobile-tah-journal")) { method, json in
                    try await native.call(method, json: json)
                }
            controller = app
            message = "Ready"
            if ProcessInfo.processInfo.arguments.contains("--mobile-tah-import") {
                try await TAHTranscriptImportFile.run(controller: app)
            }
            // Qualification is explicitly launched by the development host;
            // the phone owns every business step after this single launch.
            if ProcessInfo.processInfo.arguments.contains("--mobile-tah-qualification") {
                UIApplication.shared.isIdleTimerDisabled = true
                defer { UIApplication.shared.isIdleTimerDisabled = false }
                await TAHMobileQualification.run(controller: app)
            }
        } catch {
            message = "Preparation failed: \(String(describing: error))"
            if ProcessInfo.processInfo.arguments.contains("--mobile-tah-qualification") {
                let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                let report: [String: Any] = ["phase":"preparation_failed","errorType":String(reflecting:type(of:error)),"phoneOwned":true]
                try? JSONSerialization.data(withJSONObject: report).write(to: documents.appendingPathComponent("mobile-tah-qualification.json"),options:.atomic)
            }
        }
    }
}
