//! Network layer: HTTP client for the point-guard service and the WS event
//! stream with backoff reconnect + cursor replay. Pure client — the TUI holds
//! no task state that cannot be recovered from the service.
//!
//! /message replaced the old /chat surface (point-guard v2 deleted the
//! standing brain): every send is independent, there is no server-side
//! conversation this client resumes, and /message/history is a flat
//! display-only scrollback, not a chat log to replay as context.
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone)]
pub struct Service {
    pub base: String,
    pub secret: String,
    client: reqwest::Client,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Delegation {
    pub id: String,
    pub state: String,
    pub attempts: i64,
    /// Not rendered by any pane today. Kept decoded because the board is the
    /// natural place to show it, and dropping it would quietly narrow the
    /// contract this client claims to understand.
    #[allow(dead_code)]
    pub repo: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MessageLogEntry {
    pub message: String,
    pub reply: String,
    /// The chat pane renders entries in order and shows no timestamps, so
    /// this is decoded but unused. Kept so the ordering guarantee stays
    /// checkable if the pane ever shows times.
    #[allow(dead_code)]
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

/// `GET /debrief` — the team view. Mirrors the `Debrief` interface in
/// `bags/point-guard/src/debrief.ts`, which is the ground truth.
///
/// A container-level `rename_all` rather than the per-field `#[serde(rename)]`
/// used elsewhere in this file: this shape has ~15 camelCase fields, and
/// fifteen attributes would be noise that hides the two that matter
/// (`r#match`, and every `Option` needing `default`).
///
/// EVERY nullable field carries `#[serde(default)]`. Without it a MISSING key
/// is a hard deserialize error rather than `None`, so a server that stops
/// sending an optional field would break decoding instead of degrading.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Debrief {
    pub generated_at: i64,
    pub counts: DebriefCounts,
    #[serde(default)]
    pub sessions: Vec<DebriefSession>,
    /// Empty means the plans service answered and had none -- NOT "we could
    /// not ask". `sources.plans` is what separates those.
    #[serde(default)]
    pub plans: Vec<DebriefPlanLink>,
    #[serde(default)]
    pub trouble: Vec<DebriefTrouble>,
    /// `None` means NO NARRATIVE HAS BEEN GENERATED YET. Never a placeholder
    /// string, so "not generated" stays distinct from "generated, says little".
    #[serde(default)]
    pub narrative: Option<DebriefNarrative>,
    pub inputs_hash: String,
    pub sources: DebriefSources,
}

/// Counts are never optional: `0` is a measured zero, not "unknown". A hidden
/// row and a zero look the same to someone checking whether anything is stuck.
#[derive(Debug, Clone, Deserialize)]
pub struct DebriefCounts {
    pub total: i64,
    pub working: i64,
    pub idle: i64,
    pub stuck: i64,
    pub conflicted: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebriefSession {
    pub session_id: String,
    pub name: String,
    #[serde(default)]
    pub repo_name: Option<String>,
    /// The book's verdict, read verbatim. Kept as a string, like
    /// `Delegation::state` -- this client does not model the closed set.
    pub status: String,
    /// Non-`None` ONLY when `status != "ok"`.
    #[serde(default)]
    pub flagged_reason: Option<String>,
    /// `None` means the session has produced NO messages at all.
    #[serde(default)]
    pub idle_ms: Option<i64>,
    /// `None` means THE SLOW MERGE-TREE CHECK HAS NEVER RUN for this session.
    /// A timestamp means it ran and found no TEXTUAL conflict. Rendering both
    /// the same way is the bug the backstop exists to catch.
    #[serde(default)]
    pub merge_tree_checked_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebriefPlanLink {
    pub title: String,
    pub progress: DebriefPlanProgress,
    /// HOW this plan was tied to the session. `match` is a Rust keyword.
    /// Today only "repo" occurs, and it means "this plan names the same repo
    /// this session is in" -- NOT "this session is working on it".
    #[serde(rename = "match")]
    pub match_kind: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DebriefPlanProgress {
    pub done: i64,
    pub total: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebriefTrouble {
    pub kind: String,
    /// Taken from the underlying row, never synthesized.
    pub detail: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DebriefSources {
    pub plans: DebriefSourceStatus,
}

/// Only `last_error` is modelled: it is what decides whether an empty list
/// means "none" or "could not ask". The wire also carries `lastSucceededAt`,
/// deliberately not decoded here -- this pane does not render it, and a field
/// nothing reads is a claim of coverage the UI does not actually provide.
/// Serde ignores unknown keys, so it costs nothing to leave out.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebriefSourceStatus {
    /// `None` means the most recent attempt SUCCEEDED.
    #[serde(default)]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebriefNarrative {
    pub text: String,
    pub model: String,
    /// Differing from the debrief's own hash means this prose describes an
    /// earlier state. That, not the timestamp, is what the pane shows -- so
    /// `generatedAt` is deliberately not decoded.
    pub inputs_hash: String,
}

#[derive(Debug)]
pub enum NetEvent {
    Connected,
    Disconnected(String),
    /// A durable stream event (cursor, type, payload).
    Stream { cursor: i64, kind: String, payload: Value },
    MessageReply(String),
    MessageError(String),
    Delegations(Vec<Delegation>),
    History(Vec<MessageLogEntry>),
    Evidence { delegation_id: String, text: String },
    /// Boxed: `Debrief` is much larger than the other variants, and an
    /// unboxed one would bloat every `NetEvent` moved through the channel.
    Debrief(Box<Debrief>),
    /// The service answered but has no debrief yet (503), or the fetch
    /// failed. A SEPARATE variant from a populated debrief so the UI can say
    /// "not ready" rather than rendering an empty team as a real one.
    DebriefUnavailable(String),
    Info(String),
}

impl Service {
    pub fn from_env() -> Self {
        let base = std::env::var("BARRY_POINT_GUARD_URL").unwrap_or_else(|_| "http://127.0.0.1:3868".into());
        let secret = std::env::var("BARRY_SECRET").unwrap_or_default();
        Self { base, secret, client: reqwest::Client::new() }
    }

    fn auth(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request.header("authorization", format!("Bearer {}", self.secret))
    }

    /// Every call is independent -- point-guard's /message is the Heartbeat
    /// pattern (a fresh book snapshot per call, no chaining), so there is no
    /// idempotency key or conversation to resume, unlike the old /chat.
    pub async fn send_message(&self, content: String, tx: UnboundedSender<NetEvent>) {
        let result = self
            .auth(self.client.post(format!("{}/message", self.base)))
            .json(&json!({ "content": content }))
            .send()
            .await;
        match result {
            Ok(response) if response.status().is_success() => {
                let body: Value = response.json().await.unwrap_or_default();
                let reply = body.get("reply").and_then(Value::as_str).unwrap_or("(no reply)").to_string();
                let _ = tx.send(NetEvent::MessageReply(reply));
            }
            Ok(response) => {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                let _ = tx.send(NetEvent::MessageError(format!("{status}: {}", body.chars().take(200).collect::<String>())));
            }
            Err(error) => {
                let _ = tx.send(NetEvent::MessageError(format!("send failed: {error}")));
            }
        }
    }

    /// `GET /debrief`.
    ///
    /// Unlike the other fetches here, this one does NOT discard its errors.
    /// The service returns 503 deliberately when no supervisor tick has
    /// produced a debrief yet, so that "just started" stays distinguishable
    /// from "there are no sessions" -- swallowing it would leave the pane
    /// showing nothing, which is precisely the collapse the status code
    /// exists to prevent.
    pub async fn fetch_debrief(&self, tx: UnboundedSender<NetEvent>) {
        let result = self.auth(self.client.get(format!("{}/debrief", self.base))).send().await;
        let event = match result {
            Ok(response) if response.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE => {
                NetEvent::DebriefUnavailable("no debrief generated yet".into())
            }
            Ok(response) if response.status().is_success() => match response.json::<Value>().await {
                Ok(body) => match body.get("debrief").cloned() {
                    Some(value) => match serde_json::from_value::<Debrief>(value) {
                        Ok(debrief) => NetEvent::Debrief(Box::new(debrief)),
                        Err(error) => NetEvent::DebriefUnavailable(format!("decode failed: {error}")),
                    },
                    None => NetEvent::DebriefUnavailable("response had no debrief field".into()),
                },
                Err(error) => NetEvent::DebriefUnavailable(format!("bad json: {error}")),
            },
            Ok(response) => NetEvent::DebriefUnavailable(format!("{}", response.status())),
            Err(error) => NetEvent::DebriefUnavailable(format!("{error}")),
        };
        let _ = tx.send(event);
    }

    pub async fn fetch_delegations(&self, tx: UnboundedSender<NetEvent>) {
        if let Ok(response) = self.auth(self.client.get(format!("{}/delegations", self.base))).send().await {
            if let Ok(body) = response.json::<Value>().await {
                if let Some(list) = body.get("delegations") {
                    if let Ok(delegations) = serde_json::from_value::<Vec<Delegation>>(list.clone()) {
                        let _ = tx.send(NetEvent::Delegations(delegations));
                    }
                }
            }
        }
    }

    pub async fn fetch_message_history(&self, tx: UnboundedSender<NetEvent>) {
        if let Ok(response) = self.auth(self.client.get(format!("{}/message/history", self.base))).send().await {
            if let Ok(body) = response.json::<Value>().await {
                if let Some(list) = body.get("messages") {
                    if let Ok(messages) = serde_json::from_value::<Vec<MessageLogEntry>>(list.clone()) {
                        let _ = tx.send(NetEvent::History(messages));
                    }
                }
            }
        }
    }

    pub async fn fetch_evidence(&self, delegation_id: String, tx: UnboundedSender<NetEvent>) {
        let mut text = String::new();
        if let Ok(response) = self
            .auth(self.client.get(format!("{}/delegations/{}/report", self.base, delegation_id)))
            .send()
            .await
        {
            if let Ok(body) = response.json::<Value>().await {
                if let Some(report) = body.get("report") {
                    text.push_str("## Worker report\n");
                    text.push_str(&serde_json::to_string_pretty(report).unwrap_or_default());
                    text.push('\n');
                }
            }
        }
        if let Ok(response) = self
            .auth(self.client.get(format!("{}/delegations/{}/diff", self.base, delegation_id)))
            .send()
            .await
        {
            if let Ok(body) = response.json::<Value>().await {
                if let Some(diff) = body.get("diff").and_then(Value::as_str) {
                    text.push_str("\n## Diff\n");
                    text.push_str(diff);
                }
            }
        }
        if text.is_empty() {
            text = "(no evidence yet)".into();
        }
        let _ = tx.send(NetEvent::Evidence { delegation_id, text });
    }

    pub async fn confirm_merge(&self, delegation_id: String, tx: UnboundedSender<NetEvent>) {
        let result = self
            .auth(self.client.post(format!("{}/delegations/{}/confirm-merge", self.base, delegation_id)))
            .json(&json!({}))
            .send()
            .await;
        let message = match result {
            Ok(response) => {
                let body = response.text().await.unwrap_or_default();
                format!("confirm-merge {}: {}", delegation_id, body.chars().take(200).collect::<String>())
            }
            Err(error) => format!("confirm-merge failed: {error}"),
        };
        let _ = tx.send(NetEvent::Info(message));
    }

    pub async fn cancel(&self, delegation_id: String, tx: UnboundedSender<NetEvent>) {
        let result = self
            .auth(self.client.post(format!("{}/delegations/{}/cancel", self.base, delegation_id)))
            .json(&json!({}))
            .send()
            .await;
        let message = match result {
            Ok(response) => format!("cancel {}: {}", delegation_id, response.status()),
            Err(error) => format!("cancel failed: {error}"),
        };
        let _ = tx.send(NetEvent::Info(message));
    }
}

/// WS task: connect, replay after the last durable cursor, forward events,
/// reconnect with capped exponential backoff. Dedup happens app-side by
/// cursor; sequence-less frames never advance it.
pub async fn ws_task(service: Service, tx: UnboundedSender<NetEvent>, mut last_cursor: i64) {
    let mut backoff_ms: u64 = 1_000;
    loop {
        let ws_url = format!("{}/stream", service.base.replace("http", "ws"));
        let mut request = match ws_url.clone().into_client_request() {
            Ok(request) => request,
            Err(error) => {
                let _ = tx.send(NetEvent::Disconnected(format!("bad ws url: {error}")));
                return;
            }
        };
        request
            .headers_mut()
            .insert("authorization", format!("Bearer {}", service.secret).parse().unwrap());

        match tokio_tungstenite::connect_async(request).await {
            Ok((mut socket, _)) => {
                backoff_ms = 1_000;
                let _ = tx.send(NetEvent::Connected);
                let replay = json!({ "type": "replay", "after": last_cursor }).to_string();
                let _ = socket.send(Message::Text(replay)).await;

                while let Some(frame) = socket.next().await {
                    match frame {
                        Ok(Message::Text(text)) => {
                            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                                if value.get("type").and_then(Value::as_str) == Some("event") {
                                    if let Some(event) = value.get("event") {
                                        let cursor = event.get("cursor").and_then(Value::as_i64).unwrap_or(0);
                                        // Replay + live overlap: the durable
                                        // cursor is the dedup key.
                                        if cursor <= last_cursor {
                                            continue;
                                        }
                                        last_cursor = cursor;
                                        let kind = event.get("type").and_then(Value::as_str).unwrap_or("?").to_string();
                                        let payload = event.get("payload").cloned().unwrap_or(Value::Null);
                                        let _ = tx.send(NetEvent::Stream { cursor, kind, payload });
                                    }
                                }
                            }
                        }
                        Ok(Message::Ping(payload)) => {
                            let _ = socket.send(Message::Pong(payload)).await;
                        }
                        Ok(Message::Close(_)) | Err(_) => break,
                        _ => {}
                    }
                }
                let _ = tx.send(NetEvent::Disconnected("stream closed; reconnecting".into()));
            }
            Err(error) => {
                let _ = tx.send(NetEvent::Disconnected(format!("connect failed: {error}")));
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
        backoff_ms = (backoff_ms * 2).min(30_000);
    }
}
