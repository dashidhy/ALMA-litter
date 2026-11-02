#if PROBE_HAS_BINDINGS
import Foundation
import CryptoKit

/// Uses actual exported UniFFI methods; see api_contract.json and source notes.
/// Compile this only alongside the real generated Swift and FFI headers.
@MainActor
final class BoundProbeSession {
    private let environment: PreparedProbeEnvironment
    private let client = AppClient()
    private let store = AppStore()
    private let servers = ServerBridge()
    private var threadKey: ThreadKey?
    private var activeTurnID: String?
    private var selectedModel: String?
    private(set) var accountReady = false
    private(set) var submittedTask = false
    private(set) var verifiedAccountFingerprint: String?

    init(environment: PreparedProbeEnvironment) {
        self.environment = environment
        client.setChatgptAuthRefreshProvider(provider: ChatGPTAuthRefreshProvider())
    }

    var tasksReady: Bool { environment.taskExecutionReady }
    var hasSession: Bool { threadKey != nil }
    var canInterrupt: Bool { activeTurnID != nil }

    func connect() async throws {
        _ = try await servers.connectLocalServer(
            serverId: environment.serverID,
            displayName: environment.displayName,
            host: environment.host,
            port: environment.port
        )
        _ = try await localServerSnapshot()
    }

    func signIn() async throws {
        guard ProbeBuildReadiness.oauthLoggingReady else {
            throw ProbeGateError.authenticationUnavailable
        }
        _ = try await localServerSnapshot()
        // Tokens stay in this local variable and production Keychain/Rust auth.
        // Never put the bundle, account ID, email, or errors in observable state.
        let tokens = try await ChatGPTOAuth.login()
        try await client.loginAccount(
            serverId: environment.serverID,
            params: .chatgptAuthTokens(
                accessToken: tokens.accessToken,
                chatgptAccountId: tokens.accountID,
                chatgptPlanType: tokens.planType
            )
        )
        _ = try await checkAccount()
    }

    /// Explicit qualification action after the user has already signed in to
    /// this App. Reuses this App's Keychain, never desktop/other-App credentials.
    func restoreStoredAccount() async throws {
        let tokens = try await ChatGPTOAuth.loadStoredOrRefreshedTokens()
        try await client.loginAccount(serverId: environment.serverID,
            params: .chatgptAuthTokens(accessToken: tokens.accessToken,
                chatgptAccountId: tokens.accountID, chatgptPlanType: tokens.planType))
        guard try await checkAccount() else { throw ProbeGateError.authenticationUnavailable }
        verifiedAccountFingerprint = SHA256.hash(data: Data(tokens.accountID.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    func inspectTah() async throws -> String {
        guard accountReady, let fingerprint = verifiedAccountFingerprint else { throw ProbeGateError.authenticationUnavailable }
        return await tahQualificationInspect(serverId: environment.serverID, accountFingerprint: fingerprint)
    }

    func executeTah() async throws -> String {
        guard accountReady, let fingerprint = verifiedAccountFingerprint,
              let attempt = tahQualificationInfo(), attempt.expectedAccountFingerprint == fingerprint,
              attempt.profileDigest == ProbeBuildReadiness.profileDigest else { throw ProbeGateError.authenticationUnavailable }
        return await tahQualificationExecute(serverId: environment.serverID, accountFingerprint: fingerprint)
    }

    func verifyIdentityReply(toolsAndWeb: Bool = false) async throws -> [String: Any] {
        guard let key = threadKey else { throw ProbeGateError.sessionUnavailable }
        let nonce = UUID().uuidString.lowercased()
        let proof = "tool-proof-\(nonce).json"
        let web = "web-proof-\(nonce).json"
        let prompt = toolsAndWeb ? """
        This is a bounded synthetic tool qualification. Use only the fixed workspace.
        1. Use Bash, Python 3, and Node.js to read /workspace/input/source.txt and create /workspace/output/\(proof).
        The JSON must contain nonce="\(nonce)", the actual input's sha256 (lowercase hex), byteCount, bashArrayValue="two" obtained from a Bash array, nodeVerified=true after Node reads the file, and marker="before".
        2. Use the native apply_patch tool, not a shell executable, to change marker to "after". Read the result back.
        3. Use the official Web tool to search for AND open the official Codex app-server documentation. Do not use shell networking.
        Write /workspace/output/\(web) with nonce="\(nonce)", source_url (the official page), protocol (the documented protocol), and quote (at most 12 words copied from the page).
        Do not modify input files, install packages, download images, or run background jobs. Keep each output file below 4 KB.
        Finally return only this JSON object: {"ok":true,"nonce":"\(nonce)"}
        """ : "Return only this JSON object, without markdown or additional text: {\"ok\":true,\"nonce\":\"\(nonce)\"}. Do not use tools or access files."
        let began = ProcessInfo.processInfo.systemUptime
        try await runTask(prompt: prompt)
        while ProcessInfo.processInfo.systemUptime - began < 120 {
            _ = try await client.readThread(serverId: environment.serverID,
                // Ephemeral threads have no persisted turn-history reader.
                // Read status only; message content comes from the Rust-owned
                // canonical snapshot populated by live server events.
                params: AppReadThreadRequest(threadId: key.threadId, includeTurns: false))
            if let snapshot = try await store.threadSnapshot(key: key) {
                activeTurnID = snapshot.activeTurnId
                let answers = snapshot.hydratedConversationItems.compactMap { item -> String? in
                    if case let .assistant(message) = item.content { return message.text }
                    return nil
                }
                if case .idle = snapshot.info.status, activeTurnID == nil, let answer = answers.last {
                    let reply = try? JSONSerialization.jsonObject(with: Data(answer.utf8)) as? [String: Any]
                    let replyMatches = reply?["ok"] as? Bool == true && reply?["nonce"] as? String == nonce
                    let commands = snapshot.hydratedConversationItems.compactMap { item -> HydratedCommandExecutionData? in
                        if case let .commandExecution(command) = item.content { return command }; return nil
                    }
                    let changes = snapshot.hydratedConversationItems.compactMap { item -> HydratedFileChangeData? in
                        if case let .fileChange(change) = item.content { return change }; return nil
                    }
                    let searches = snapshot.hydratedConversationItems.compactMap { item -> HydratedWebSearchData? in
                        if case let .webSearch(search) = item.content { return search }; return nil
                    }
                    var result: [String: Any] = ["model": selectedModel ?? "unknown", "nonce": nonce,
                            "kind": toolsAndWeb ? "tools-and-web" : "identity-json",
                            "seconds": ProcessInfo.processInfo.systemUptime - began,
                            "terminalIdle": true, "assistantMessages": answers.count,
                            "replyMatches": replyMatches, "allChecksPassed": replyMatches,
                            "replyCharacters": answer.count, "syntheticReplyPreview": String(answer.prefix(400)),
                            "commandCount": commands.count, "fileChangeCount": changes.count, "webSearchCount": searches.count,
                            "webActions": searches.map { search -> [String: Any] in
                                ["query": String(search.query.prefix(600)),
                                 "action": String((search.actionJson ?? "").prefix(1200)),
                                 "inProgress": search.isInProgress]
                            },
                            "commands": commands.map { command -> [String: Any] in
                                ["command": String(command.command.prefix(1400)),
                                 "cwd": command.cwd,
                                 "output": String((command.output ?? "").prefix(2000)),
                                 "exitCode": command.exitCode.map { NSNumber(value: $0) as Any } ?? NSNull(),
                                 "durationMs": command.durationMs.map { NSNumber(value: $0) as Any } ?? NSNull()]
                            }]
                    if toolsAndWeb {
                        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                        let root = support.appendingPathComponent("alma-local-workspace")
                        let input = try Data(contentsOf: root.appendingPathComponent("input/source.txt"))
                        let hash = SHA256.hash(data: input).map { String(format: "%02x", $0) }.joined()
                        func object(_ name: String) -> [String: Any]? {
                            let path = root.appendingPathComponent("output").appendingPathComponent(name)
                            guard let attrs = try? FileManager.default.attributesOfItem(atPath: path.path),
                                  let size = attrs[.size] as? NSNumber, size.intValue <= 65_536,
                                  let bytes = try? Data(contentsOf: path) else { return nil }
                            return try? JSONSerialization.jsonObject(with: bytes) as? [String: Any]
                        }
                        let artifact = object(proof), citation = object(web)
                        let artifactMatches = artifact?["nonce"] as? String == nonce && artifact?["sha256"] as? String == hash
                            && artifact?["byteCount"] as? Int == input.count && artifact?["bashArrayValue"] as? String == "two"
                            && artifact?["nodeVerified"] as? Bool == true && artifact?["marker"] as? String == "after"
                        let url = (citation?["source_url"] as? String).flatMap(URL.init(string:))
                        let official = url?.scheme == "https" && (url?.host == "developers.openai.com" ||
                            (url?.host == "learn.chatgpt.com" && url?.path == "/docs/app-server") ||
                            (url?.host == "github.com" && url?.path.hasPrefix("/openai/codex") == true))
                        let webMatches = citation?["nonce"] as? String == nonce && official &&
                            !(citation?["quote"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        result["artifactMatches"] = artifactMatches
                        result["webArtifactMatches"] = webMatches
                        result["proofFile"] = proof
                        result["webFile"] = web
                        result["allChecksPassed"] = artifactMatches && webMatches &&
                            commands.contains { $0.status == .completed && $0.exitCode == 0 } &&
                            !commands.contains { $0.status == .inProgress } &&
                            changes.contains { $0.status == .completed } && searches.contains { !$0.isInProgress }
                    }
                    return result
                }
                if case .systemError = snapshot.info.status { throw ProbeGateError.modelVerificationFailed }
            }
            try await Task.sleep(nanoseconds: 2_000_000_000)
        }
        if activeTurnID != nil { try? await interruptTask() }
        throw ProbeGateError.modelVerificationTimedOut
    }

    func checkAccount() async throws -> Bool {
        accountReady = false
        try await client.refreshAccount(
            serverId: environment.serverID,
            params: AppRefreshAccountRequest(refreshToken: false)
        )
        // The actual account API supports requesting status without token data.
        _ = try await client.authStatus(
            serverId: environment.serverID,
            params: AuthStatusRequest(includeToken: false, refreshToken: false)
        )
        let server = try await localServerSnapshot()
        if let account = server.account, case .chatgpt = account {
            accountReady = true
        }
        return accountReady
    }

    func checkModels() async throws -> Int {
        guard accountReady else { throw ProbeGateError.authenticationUnavailable }
        try await client.refreshModels(
            serverId: environment.serverID,
            params: AppRefreshModelsRequest(cursor: nil, limit: 100, includeHidden: false)
        )
        let server = try await localServerSnapshot()
        let models = (server.availableModels ?? []).filter {
            $0.agentRuntimeKind == "codex" && !$0.hidden
        }
        selectedModel = models.first(where: { $0.isDefault })?.model ?? models.first?.model
        return models.count
    }

    func createSession() async throws {
        guard tasksReady, accountReady, selectedModel != nil, threadKey == nil else {
            throw ProbeGateError.taskEnvironmentUnavailable
        }
        _ = try await localServerSnapshot()
        threadKey = try await client.startThread(
            serverId: environment.serverID,
            params: AppStartThreadRequest(
                agentRuntimeKind: "codex",
                model: selectedModel,
                cwd: QualificationWorkspace.output,
                approvalPolicy: nil,
                sandbox: nil,
                developerInstructions: nil,
                persistExtendedHistory: false,
                dynamicTools: nil,
                ephemeral: true
            )
        )
    }

    func runTask(prompt: String = "Qualification check: reply exactly ALMA local agent probe OK. Do not use tools or access files.") async throws {
        guard tasksReady, accountReady, let key = threadKey, !submittedTask else {
            throw ProbeGateError.taskEnvironmentUnavailable
        }
        // Mark before sending: uncertain transport failure must not auto-resubmit.
        submittedTask = true
        try await store.startTurn(
            key: key,
            params: AppStartTurnRequest(
                threadId: key.threadId,
                input: [.text(text: prompt, textElements: [])],
                approvalPolicy: nil,
                sandboxPolicy: nil,
                model: selectedModel,
                serviceTier: nil,
                effort: nil,
                outputSchema: nil
            )
        )
    }

    func checkTaskStatus() async throws -> String {
        guard let key = threadKey else { throw ProbeGateError.sessionUnavailable }
        _ = try await client.readThread(
            serverId: environment.serverID,
            params: AppReadThreadRequest(threadId: key.threadId, includeTurns: false)
        )
        guard let thread = try await store.threadSnapshot(key: key) else {
            throw ProbeGateError.sessionUnavailable
        }
        activeTurnID = thread.activeTurnId
        if activeTurnID != nil { return "Active turn reported" }
        switch thread.info.status {
        case .active: return "Active"
        case .idle: return "Idle — no active turn reported"
        case .notLoaded: return "Thread not loaded"
        case .systemError: return "Runtime reported an error"
        }
    }

    func interruptTask() async throws {
        guard let key = threadKey, let turnID = activeTurnID else {
            throw ProbeGateError.sessionUnavailable
        }
        try await client.interruptTurn(
            serverId: environment.serverID,
            params: AppInterruptTurnRequest(threadId: key.threadId, turnId: turnID)
        )
        activeTurnID = nil
    }

    private func localServerSnapshot() async throws -> AppServerSnapshot {
        let snapshot = try await store.snapshot()
        guard let server = snapshot.servers.first(where: { $0.serverId == environment.serverID }),
              server.isLocal, case .connected = server.transportState else {
            throw ProbeGateError.localConnectionUnavailable
        }
        return server
    }
}
#endif
