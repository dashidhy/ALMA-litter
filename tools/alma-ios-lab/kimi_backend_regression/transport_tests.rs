//! Tests use only loopback HTTP and fake credentials. Native admission is tested
//! separately, while the private response pump can use an in-process server.
use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn policy(web: bool) -> RequestPolicy {
    RequestPolicy {
        attempt_id: "a".into(),
        model: "kimi-for-coding".into(),
        effort: "high".into(),
        web,
    }
}
fn model_request() -> Value {
    json!({"url":"https://api.kimi.com/coding/v1/chat/completions", "method":"POST", "headers":{},
        "body":json!({"model":"kimi-for-coding","thinking":{"type":"enabled","effort":"high"}}).to_string()})
}

#[test]
fn process_failures_keep_static_categories_without_private_text() {
    assert_eq!(process_failure_category("iSH output budget exceeded"), "kimi_process_output_limit");
    assert_eq!(process_failure_category("iSH retained output was lost before collection"), "kimi_process_output_lost");
    assert_eq!(process_failure_category("private path or process contents"), "kimi_process_failed");
}
#[test]
fn sensitive_authorization_is_host_owned_and_extra_credentials_are_discarded() {
    let client = reqwest::Client::new();
    let mut authorization = HeaderValue::from_static("Bearer host-only-fixture");
    authorization.set_sensitive(true);
    let mut frame = model_request();
    frame["headers"] = json!({"Authorization":"Bearer guest-placeholder", "x-api-key":"guest-placeholder", "host":"other.example",
        "cookie":"private", "proxy-authorization":"private", "content-length":"999", "content-type":"application/json", "user-agent":"kimi"});
    let request = policy(false)
        .request(&frame, &client, &authorization)
        .unwrap();
    assert_eq!(request.headers()[AUTHORIZATION], "Bearer host-only-fixture");
    assert!(request.headers()[AUTHORIZATION].is_sensitive());
    for name in [
        "x-api-key",
        "host",
        "cookie",
        "proxy-authorization",
        "content-length",
    ] {
        assert!(!request.headers().contains_key(name));
    }
    assert_eq!(request.headers()["content-type"], "application/json");
}
#[test]
fn only_explicit_web_grants_admit_search_and_fetch() {
    let client = reqwest::Client::new();
    let authorization = HeaderValue::from_static("Bearer fixture");
    for route in ["search", "fetch"] {
        let mut frame = model_request();
        frame["url"] = json!(format!("https://api.kimi.com/coding/v1/{route}"));
        frame["body"] = json!("{}");
        assert!(
            policy(false)
                .request(&frame, &client, &authorization)
                .is_err()
        );
        assert!(
            policy(true)
                .request(&frame, &client, &authorization)
                .is_ok()
        );
    }
}

#[test]
fn pinned_sdk_web_codec_fixtures_preserve_body_and_tool_identity() {
    let fixtures: Value = serde_json::from_str(include_str!("web-codec-fixtures.json")).unwrap();
    assert_eq!(fixtures["releaseVersion"], "2.4.1");
    assert_eq!(fixtures["sdkVersion"], "0.22.0");
    let client = reqwest::Client::new();
    let mut authorization = HeaderValue::from_static("Bearer host-only-fixture");
    authorization.set_sensitive(true);
    for fixture in fixtures["fixtures"].as_array().unwrap() {
        let frame = &fixture["frame"];
        assert!(
            policy(false)
                .request(frame, &client, &authorization)
                .is_err()
        );
        let request = policy(true)
            .request(frame, &client, &authorization)
            .unwrap();
        assert_eq!(
            request.body().unwrap().as_bytes().unwrap(),
            frame["body"].as_str().unwrap().as_bytes()
        );
        assert_eq!(request.headers()["content-type"], "application/json");
        assert_eq!(request.headers()["x-msh-tool-call-id"], "fixture-tool");
        assert_eq!(request.headers()[AUTHORIZATION], "Bearer host-only-fixture");
        if frame["headers"].get("Accept").is_some() {
            assert_eq!(request.headers()["accept"], "text/markdown");
        }
    }
}
#[test]
fn body_headers_and_line_sizes_are_bounded() {
    let client = reqwest::Client::new();
    let authorization = HeaderValue::from_static("Bearer fixture");
    let mut frame = model_request();
    frame["body"] = json!("a".repeat(MAX_BODY_BYTES + 1));
    assert_eq!(
        policy(false).request(&frame, &client, &authorization).err(),
        Some("kimi_body_limit")
    );
    let mut frame = model_request();
    frame["headers"] = json!({"accept":"a".repeat(MAX_HEADER_BYTES)});
    assert_eq!(
        policy(false).request(&frame, &client, &authorization).err(),
        Some("kimi_headers_limit")
    );
    let mut lines = Lines::default();
    assert_eq!(
        lines.push(&vec![b'a'; MAX_FRAME_BYTES + 1]).err(),
        Some("kimi_frame_limit")
    );
    assert_eq!(
        lines.push(b"__ALMA_KIMI__invalid\n").err(),
        Some("kimi_frame_invalid")
    );
}

async fn server(response: Vec<u8>) -> (reqwest::Client, reqwest::Request, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = [0u8; 4096];
        let _ = stream.read(&mut bytes).await.unwrap();
        stream.write_all(&response).await.unwrap();
    });
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let request = client
        .post(format!("http://{address}/test"))
        .body("{}")
        .build()
        .unwrap();
    (client, request, task)
}
async fn receive(receiver: &mut mpsc::Receiver<Outgoing>) -> Value {
    let outgoing = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
        .await
        .unwrap()
        .unwrap();
    outgoing.delivered.send(Ok(())).unwrap();
    outgoing.frame
}
#[tokio::test]
async fn http_response_waits_for_each_consumer_ack() {
    let body = vec![b'x'; CHUNK_BYTES * 2 + 7];
    let mut response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: text/event-stream\r\nSet-Cookie: private\r\n\r\n", body.len()).into_bytes();
    response.extend(&body);
    let (client, request, server) = server(response).await;
    let (send, mut receive_frames) = mpsc::channel(4);
    let (ack, acknowledgements) = mpsc::channel(1);
    let task =
        tokio::spawn(
            async move { http_request(1, client, request, &send, acknowledgements).await },
        );
    let headers = receive(&mut receive_frames).await;
    assert_eq!(headers["kind"], "headers");
    assert_eq!(
        headers["headers"],
        json!({"content-type":"text/event-stream"})
    );
    let mut actual = Vec::new();
    loop {
        let frame = receive(&mut receive_frames).await;
        if frame["kind"] == "end" {
            break;
        }
        assert_eq!(frame["kind"], "chunk");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(frame["data"].as_str().unwrap())
            .unwrap();
        assert!(bytes.len() <= CHUNK_BYTES);
        actual.extend(bytes);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), receive_frames.recv())
                .await
                .is_err()
        );
        ack.send(()).await.unwrap();
    }
    assert_eq!(actual, body);
    assert!(task.await.unwrap().is_ok());
    server.await.unwrap();
}

#[test]
fn model_streams_use_attempt_deadline_and_web_keeps_request_deadline() {
    let client = reqwest::Client::new();
    for route in ["messages", "chat/completions", "search", "fetch"] {
        let request = client.post(format!("https://api.kimi.com/coding/v1/{route}")).build().unwrap();
        let expected = if ["search", "fetch"].contains(&route) { REQUEST_TIMEOUT } else { ATTEMPT_TIMEOUT };
        assert_eq!(request_timeout(&request), expected);
    }
}

#[tokio::test]
async fn productive_model_stream_outlives_read_timeout_but_stalled_stream_fails() {
    for (stalled, total_timeout) in [(false, false), (true, false), (false, true)] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            socket.read(&mut request).await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\n").await.unwrap();
            if stalled {
                tokio::time::sleep(Duration::from_millis(400)).await;
                return;
            }
            for _ in 0..8 {
                tokio::time::sleep(Duration::from_millis(50)).await;
                if socket.write_all(b"x").await.is_err() { break; }
            }
        });
        let builder = reqwest::Client::builder();
        let builder = if total_timeout { builder.timeout(Duration::from_millis(200)) }
            else { builder.read_timeout(Duration::from_millis(200)) };
        let client = builder.build().unwrap();
        let request = client.get(format!("http://{address}")).build().unwrap();
        let (send, mut frames) = mpsc::channel(4);
        let (ack, acknowledgements) = mpsc::channel(1);
        let task = tokio::spawn(async move { http_request(1, client, request, &send, acknowledgements).await });
        assert_eq!(receive(&mut frames).await["kind"], "headers");
        let mut received = 0;
        let mut ended = false;
        while let Some(frame) = frames.recv().await {
            frame.delivered.send(Ok(())).unwrap();
            if frame.frame["kind"] == "end" { ended = true; break; }
            assert_eq!(frame.frame["kind"], "chunk");
            received += base64::engine::general_purpose::STANDARD.decode(frame.frame["data"].as_str().unwrap()).unwrap().len();
            ack.send(()).await.unwrap();
        }
        let result = task.await.unwrap();
        if stalled || total_timeout {
            assert_eq!(result.err(), Some("kimi_http_timeout"));
            assert!(!ended);
        } else {
            assert!(result.is_ok());
            assert!(ended);
            assert_eq!(received, 8);
        }
        server.await.unwrap();
    }
}
#[tokio::test]
async fn redirects_and_oversized_responses_fail_before_delivery() {
    for (response, expected) in [
        (
            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/never\r\nContent-Length: 0\r\n\r\n"
                .into(),
            "kimi_redirect_denied",
        ),
        (
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                MAX_RESPONSE_BYTES + 1
            ),
            "kimi_response_limit",
        ),
    ] {
        let (client, request, server) = server(response.into_bytes()).await;
        let (send, mut incoming) = mpsc::channel(4);
        let (_ack, acknowledgements) = mpsc::channel(1);
        assert_eq!(
            http_request(1, client, request, &send, acknowledgements)
                .await
                .err(),
            Some(expected)
        );
        assert!(incoming.try_recv().is_err());
        server.await.unwrap();
    }
}

#[tokio::test]
async fn model_sse_wire_budget_exceeds_web_page_budget_with_bounded_chunks() {
    let body = vec![b'x'; 3 * 1024 * 1024];
    let mut response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: text/event-stream\r\n\r\n", body.len()).into_bytes();
    response.extend(&body);
    let (client, mut request, server) = server(response).await;
    request.url_mut().set_path("/coding/v1/chat/completions");
    let (send, mut frames) = mpsc::channel(4);
    let (ack, acknowledgements) = mpsc::channel(1);
    let task = tokio::spawn(async move { http_request(1, client, request, &send, acknowledgements).await });
    assert_eq!(receive(&mut frames).await["kind"], "headers");
    let mut received = 0;
    loop {
        let frame = receive(&mut frames).await;
        if frame["kind"] == "end" { break; }
        let chunk = base64::engine::general_purpose::STANDARD.decode(frame["data"].as_str().unwrap()).unwrap();
        assert!(chunk.len() <= CHUNK_BYTES);
        received += chunk.len();
        ack.send(()).await.unwrap();
    }
    assert_eq!(received, body.len());
    assert!(task.await.unwrap().is_ok());
    server.await.unwrap();
}

#[tokio::test]
async fn model_response_limit_remains_finite() {
    let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", MAX_MODEL_RESPONSE_BYTES + 1);
    let (client, mut request, server) = server(response.into_bytes()).await;
    request.url_mut().set_path("/coding/v1/messages");
    let (send, mut frames) = mpsc::channel(4);
    let (_ack, acknowledgements) = mpsc::channel(1);
    assert_eq!(http_request(1, client, request, &send, acknowledgements).await.err(), Some("kimi_response_limit"));
    assert!(frames.try_recv().is_err());
    server.await.unwrap();
}
#[tokio::test]
async fn blocked_ack_task_aborts_and_joins_without_more_frames() {
    let (client, request, server) =
        server(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc".to_vec()).await;
    let (send, mut incoming) = mpsc::channel(4);
    let (_ack, acknowledgements) = mpsc::channel(1);
    let task =
        tokio::spawn(
            async move { http_request(1, client, request, &send, acknowledgements).await },
        );
    assert_eq!(receive(&mut incoming).await["kind"], "headers");
    assert_eq!(receive(&mut incoming).await["kind"], "chunk");
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(incoming.recv().await.is_none());
    server.await.unwrap();
}
