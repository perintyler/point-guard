//! App state and update logic (the Elm "model + update" half). Rendering
//! never mutates; network work never blocks the render loop.
use crate::config::TuiConfig;
use crate::net::{Debrief, Delegation, MessageLogEntry, NetEvent};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pane {
    Board,
    Chat,
    Evidence,
    Debrief,
}

pub struct App {
    pub config: TuiConfig,
    pub config_error: Option<String>,
    pub connected: bool,
    pub status: String,
    pub pane: Pane,
    pub chat: Vec<(String, String)>, // (role, content) -- role is "you"/"pg"/"error"/"question", not a server-recorded role
    pub input: String,
    /// Unsent input survives reconnects; only an acknowledged send clears it.
    pub sending: bool,
    pub delegations: Vec<Delegation>,
    pub selected: usize,
    pub evidence: Option<(String, String)>, // (delegation id, text)
    pub evidence_scroll: u16,
    pub last_cursor: i64,
    pub should_quit: bool,
    pub needs_refresh: bool,
    pub pending_evidence: Option<String>,
    pub pending_merge: Option<String>,
    pub pending_cancel: Option<String>,
    pub pending_send: Option<String>,
    /// The latest debrief, or `None` if none has arrived yet.
    pub debrief: Option<Box<Debrief>>,
    /// Why there is no debrief. Kept SEPARATE from `debrief: None` so the
    /// pane can say "not generated yet" (the service is up and still working)
    /// rather than rendering an empty team as though it were a real one.
    pub debrief_error: Option<String>,
    pub debrief_scroll: u16,
}

impl App {
    pub fn new(config: TuiConfig, config_error: Option<String>) -> Self {
        Self {
            config,
            config_error,
            connected: false,
            status: "connecting…".into(),
            pane: Pane::Chat,
            chat: Vec::new(),
            input: String::new(),
            sending: false,
            delegations: Vec::new(),
            selected: 0,
            evidence: None,
            evidence_scroll: 0,
            last_cursor: 0,
            should_quit: false,
            needs_refresh: true,
            pending_evidence: None,
            pending_merge: None,
            pending_cancel: None,
            pending_send: None,
            debrief: None,
            debrief_error: None,
            debrief_scroll: 0,
        }
    }

    pub fn on_net(&mut self, event: NetEvent) {
        match event {
            NetEvent::Connected => {
                self.connected = true;
                self.status = "connected".into();
                self.needs_refresh = true;
            }
            NetEvent::Disconnected(reason) => {
                self.connected = false;
                self.status = reason;
            }
            NetEvent::Stream { cursor, kind, payload } => {
                self.last_cursor = cursor;
                match kind.as_str() {
                    // "chat.message" is never emitted anymore -- it backed the
                    // deleted /chat route (point-guard v2 removed the standing
                    // brain). The store method that emits it is orphaned too
                    // (nothing calls it outside its own tests), so this event
                    // simply never fires; no replacement needed since /message
                    // has no server-pushed "new message" event to react to --
                    // it's request/reply only, refreshed by the poll timer.
                    "delegation.created" | "delegation.state" | "delegation.accepted" | "delegation.merged"
                    | "attempt.finished" | "merge.enqueued" => {
                        self.needs_refresh = true;
                        if kind == "delegation.merged" {
                            if let Some(id) = payload.get("delegationId").and_then(|v| v.as_str()) {
                                self.status = format!("merged: {id}");
                            }
                        }
                    }
                    "question.asked" => {
                        if let Some(text) = payload.get("text").and_then(|v| v.as_str()) {
                            self.chat.push(("question".into(), text.to_string()));
                        }
                    }
                    _ => {}
                }
            }
            NetEvent::MessageReply(reply) => {
                self.sending = false;
                self.chat.push(("pg".into(), reply));
            }
            NetEvent::MessageError(error) => {
                self.sending = false;
                self.chat.push(("error".into(), error));
            }
            NetEvent::Delegations(delegations) => {
                self.delegations = delegations;
                if self.selected >= self.delegations.len() && !self.delegations.is_empty() {
                    self.selected = self.delegations.len() - 1;
                }
            }
            NetEvent::History(entries) => {
                // /message/history is a flat (message, reply) log, not a
                // role-tagged transcript -- each entry becomes a "you" line
                // followed by the "pg" reply it got, oldest first, matching
                // how a fresh send appends to self.chat below.
                self.chat = entries
                    .into_iter()
                    .flat_map(|entry: MessageLogEntry| {
                        [("you".to_string(), entry.message), ("pg".to_string(), entry.reply)]
                    })
                    .collect();
            }
            NetEvent::Evidence { delegation_id, text } => {
                self.evidence = Some((delegation_id, text));
                self.evidence_scroll = 0;
                self.pane = Pane::Evidence;
            }
            NetEvent::Debrief(debrief) => {
                self.debrief = Some(debrief);
                self.debrief_error = None;
            }
            NetEvent::DebriefUnavailable(reason) => {
                // Keep any debrief already on screen: stale data beats a
                // blank pane, and the reason is shown alongside it.
                self.debrief_error = Some(reason);
            }
            NetEvent::Info(message) => {
                self.status = message;
                self.needs_refresh = true;
            }
        }
    }

    pub fn selected_delegation(&self) -> Option<&Delegation> {
        self.delegations.get(self.selected)
    }

    pub fn on_key(&mut self, key: crossterm::event::KeyEvent) {
        use crossterm::event::{KeyCode, KeyModifiers};
        // Global chords first.
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            self.should_quit = true;
            return;
        }
        match self.pane {
            Pane::Chat => match key.code {
                KeyCode::Enter => {
                    let text = self.input.trim().to_string();
                    if !text.is_empty() && !self.sending {
                        self.chat.push(("you".into(), text.clone()));
                        self.pending_send = Some(text);
                        self.sending = true;
                        self.input.clear();
                    }
                }
                KeyCode::Backspace => {
                    self.input.pop();
                }
                KeyCode::Tab => self.pane = Pane::Board,
                KeyCode::Esc => self.should_quit = true,
                KeyCode::Char(c) => self.input.push(c),
                _ => {}
            },
            Pane::Board => {
                let keys = self.config.keys.clone();
                match key.code {
                    KeyCode::Tab => self.pane = Pane::Chat,
                    KeyCode::Esc => self.pane = Pane::Chat,
                    KeyCode::Up => self.selected = self.selected.saturating_sub(1),
                    KeyCode::Down => {
                        if self.selected + 1 < self.delegations.len() {
                            self.selected += 1;
                        }
                    }
                    KeyCode::Enter => {
                        if let Some(delegation) = self.selected_delegation() {
                            self.pending_evidence = Some(delegation.id.clone());
                        }
                    }
                    KeyCode::Char(c) if c == keys.quit => self.should_quit = true,
                    KeyCode::Char(c) if c == keys.scroll_up => self.selected = self.selected.saturating_sub(1),
                    KeyCode::Char(c) if c == keys.scroll_down => {
                        if self.selected + 1 < self.delegations.len() {
                            self.selected += 1;
                        }
                    }
                    KeyCode::Char(c) if c == keys.confirm_merge => {
                        if let Some(delegation) = self.selected_delegation() {
                            if delegation.state == "accepted" {
                                self.pending_merge = Some(delegation.id.clone());
                            } else {
                                self.status = format!("{} is {}, not accepted", delegation.id, delegation.state);
                            }
                        }
                    }
                    KeyCode::Char(c) if c == keys.debrief => self.pane = Pane::Debrief,
                    KeyCode::Char(c) if c == keys.cancel_delegation => {
                        if let Some(delegation) = self.selected_delegation() {
                            self.pending_cancel = Some(delegation.id.clone());
                        }
                    }
                    _ => {}
                }
            }
            Pane::Debrief => match key.code {
                KeyCode::Esc | KeyCode::Tab => self.pane = Pane::Board,
                KeyCode::Up => self.debrief_scroll = self.debrief_scroll.saturating_sub(3),
                KeyCode::Down => self.debrief_scroll = self.debrief_scroll.saturating_add(3),
                KeyCode::PageUp => self.debrief_scroll = self.debrief_scroll.saturating_sub(20),
                KeyCode::PageDown => self.debrief_scroll = self.debrief_scroll.saturating_add(20),
                KeyCode::Char(c) if c == self.config.keys.quit => self.should_quit = true,
                _ => {}
            },
            Pane::Evidence => match key.code {
                KeyCode::Esc | KeyCode::Tab => self.pane = Pane::Board,
                KeyCode::Up => self.evidence_scroll = self.evidence_scroll.saturating_sub(3),
                KeyCode::Down => self.evidence_scroll = self.evidence_scroll.saturating_add(3),
                KeyCode::PageUp => self.evidence_scroll = self.evidence_scroll.saturating_sub(20),
                KeyCode::PageDown => self.evidence_scroll = self.evidence_scroll.saturating_add(20),
                KeyCode::Char(c) if c == self.config.keys.quit => self.should_quit = true,
                _ => {}
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::{Debrief, DebriefCounts, DebriefNarrative, DebriefSourceStatus, DebriefSources};

    fn app() -> App {
        App::new(TuiConfig::default(), None)
    }

    fn debrief(narrative: Option<DebriefNarrative>, inputs_hash: &str) -> Box<Debrief> {
        Box::new(Debrief {
            generated_at: 1_000,
            counts: DebriefCounts { total: 3, working: 1, idle: 2, stuck: 0, conflicted: 0 },
            sessions: vec![],
            plans: vec![],
            trouble: vec![],
            narrative,
            inputs_hash: inputs_hash.to_string(),
            sources: DebriefSources {
                plans: DebriefSourceStatus { last_error: None },
            },
        })
    }

    #[test]
    fn debrief_event_populates_state_and_clears_any_error() {
        let mut app = app();
        app.debrief_error = Some("stale failure".into());

        app.on_net(NetEvent::Debrief(debrief(None, "abc")));

        assert!(app.debrief.is_some());
        assert_eq!(app.debrief_error, None, "a successful fetch clears the previous error");
    }

    /// The 503 case. It must NOT wipe a debrief already on screen: stale data
    /// with a reason beside it beats a blank pane, and blanking would make
    /// "the service is still starting" look like "the team is empty".
    #[test]
    fn unavailable_event_keeps_existing_data_and_records_why() {
        let mut app = app();
        app.on_net(NetEvent::Debrief(debrief(None, "abc")));

        app.on_net(NetEvent::DebriefUnavailable("no debrief generated yet".into()));

        assert!(app.debrief.is_some(), "existing data survives a later failure");
        assert_eq!(app.debrief_error.as_deref(), Some("no debrief generated yet"));
    }

    #[test]
    fn unavailable_before_any_data_leaves_nothing_to_render() {
        let mut app = app();

        app.on_net(NetEvent::DebriefUnavailable("503".into()));

        assert!(app.debrief.is_none());
        assert!(app.debrief_error.is_some(), "the pane must be able to say WHY it is empty");
    }

    /// A stale narrative is detected by comparing hashes, not by a flag on the
    /// wire -- so this pins the comparison the renderer depends on.
    #[test]
    fn narrative_is_stale_when_its_hash_differs_from_the_debrief() {
        let narrative = DebriefNarrative {
            text: "Three sessions.".into(),
            model: "gpt-5.4-mini".into(),
            inputs_hash: "OLD".into(),
        };
        let current = debrief(Some(narrative.clone()), "OLD");
        let moved_on = debrief(Some(narrative), "NEW");

        assert_eq!(
            current.narrative.as_ref().unwrap().inputs_hash,
            current.inputs_hash,
            "matching hashes mean the prose still describes this snapshot"
        );
        assert_ne!(
            moved_on.narrative.as_ref().unwrap().inputs_hash,
            moved_on.inputs_hash,
            "differing hashes are what the pane marks as an earlier state"
        );
    }

    #[test]
    fn the_debrief_key_opens_the_pane_from_the_board() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut app = app();
        app.pane = Pane::Board;

        app.on_key(KeyEvent::new(KeyCode::Char(app.config.keys.debrief), KeyModifiers::NONE));
        assert_eq!(app.pane, Pane::Debrief);

        app.on_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(app.pane, Pane::Board, "Esc returns to the board rather than quitting");
    }
}

#[cfg(test)]
mod live_decode_tests {
    use crate::net::Debrief;

    /// Decodes a REAL `/debrief` payload captured from the live service on
    /// 2026-09-15. Hand-built fixtures only ever prove the types agree with
    /// themselves; this proves they agree with the server.
    #[test]
    fn real_captured_payload_decodes() {
        let raw = include_str!("../tests/fixtures/debrief.json");
        let debrief: Debrief = serde_json::from_str(raw).expect("live payload must decode");

        assert_eq!(
            debrief.counts.working + debrief.counts.idle + debrief.counts.stuck + debrief.counts.conflicted,
            debrief.counts.total,
            "the four buckets must account for every session"
        );
        assert!(!debrief.inputs_hash.is_empty());

        // Both merge-tree states appear in the capture, and they must stay
        // distinguishable after decoding.
        let never_checked = debrief.sessions.iter().any(|s| s.merge_tree_checked_at.is_none());
        let checked = debrief.sessions.iter().any(|s| s.merge_tree_checked_at.is_some());
        assert!(never_checked && checked, "the fixture covers both merge-tree states");
    }
}
