//! Rendering (the Elm "view" half). Pure function of App state.
use crate::app::{App, Pane};
use crate::net::Delegation;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, Paragraph, Wrap};
use ratatui::Frame;

fn color(name: &str) -> Color {
    match name {
        "cyan" => Color::Cyan,
        "green" => Color::Green,
        "yellow" => Color::Yellow,
        "red" => Color::Red,
        "magenta" => Color::Magenta,
        "blue" => Color::Blue,
        _ => Color::White,
    }
}

fn state_style(app: &App, state: &str) -> Style {
    let theme = &app.config.theme;
    match state {
        "merged" | "accepted" => Style::default().fg(color(&theme.ok)),
        "blocked" | "failed" | "cancelled" => Style::default().fg(color(&theme.err)),
        "running" | "verifying" | "integrating" => Style::default().fg(color(&theme.warn)),
        _ => Style::default(),
    }
}

pub fn draw(frame: &mut Frame, app: &App) {
    let outer = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(5), Constraint::Length(3), Constraint::Length(1)])
        .split(frame.area());

    let main = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(app.config.layout.board_width_pct.min(80)),
            Constraint::Min(20),
        ])
        .split(outer[0]);

    draw_board(frame, app, main[0]);
    // A `match`, not an if/else chain: adding a Pane variant without a render
    // arm used to fall silently through to the chat pane, so a new pane would
    // compile and then draw the wrong thing. This makes the compiler catch it.
    match app.pane {
        Pane::Evidence => draw_evidence(frame, app, main[1]),
        Pane::Debrief => draw_debrief(frame, app, main[1]),
        Pane::Board | Pane::Chat => draw_chat(frame, app, main[1]),
    }
    draw_input(frame, app, outer[1]);
    draw_status(frame, app, outer[2]);
}

fn draw_board(frame: &mut Frame, app: &App, area: Rect) {
    let focused = app.pane == Pane::Board;
    let items: Vec<ListItem> = app
        .delegations
        .iter()
        .enumerate()
        .map(|(index, delegation): (usize, &Delegation)| {
            let marker = if index == app.selected && focused { "▶ " } else { "  " };
            let line = Line::from(vec![
                Span::raw(marker),
                Span::styled(format!("[{}] ", delegation.state), state_style(app, &delegation.state)),
                Span::raw(format!("{} a{}", &delegation.id[..delegation.id.len().min(12)], delegation.attempts)),
            ]);
            let mut item = vec![line];
            if let Some(reason) = &delegation.reason {
                if index == app.selected {
                    item.push(Line::from(Span::styled(
                        format!("    {}", reason.chars().take(60).collect::<String>()),
                        Style::default().add_modifier(Modifier::DIM),
                    )));
                }
            }
            ListItem::new(item)
        })
        .collect();
    let title = format!(" task board ({}) ", app.delegations.len());
    let border = if focused {
        Style::default().fg(color(&app.config.theme.accent))
    } else {
        Style::default()
    };
    frame.render_widget(
        List::new(items).block(Block::default().borders(Borders::ALL).title(title).border_style(border)),
        area,
    );
}

fn draw_chat(frame: &mut Frame, app: &App, area: Rect) {
    let focused = app.pane == Pane::Chat;
    let mut lines: Vec<Line> = Vec::new();
    let visible = area.height.saturating_sub(2) as usize;
    for (role, content) in app.chat.iter().rev().take(visible * 2).rev() {
        let style = match role.as_str() {
            "you" | "user" => Style::default().fg(color(&app.config.theme.accent)),
            "error" => Style::default().fg(color(&app.config.theme.err)),
            "question" => Style::default().fg(color(&app.config.theme.warn)),
            _ => Style::default(),
        };
        for (i, part) in content.lines().enumerate() {
            if i == 0 {
                lines.push(Line::from(vec![
                    Span::styled(format!("{role}› "), style.add_modifier(Modifier::BOLD)),
                    Span::raw(part.to_string()),
                ]));
            } else {
                lines.push(Line::from(Span::raw(format!("   {part}"))));
            }
        }
    }
    let border = if focused {
        Style::default().fg(color(&app.config.theme.accent))
    } else {
        Style::default()
    };
    let scroll = lines.len().saturating_sub(visible) as u16;
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((scroll, 0))
            .block(Block::default().borders(Borders::ALL).title(" point-guard ").border_style(border)),
        area,
    );
}

fn draw_evidence(frame: &mut Frame, app: &App, area: Rect) {
    let (id, text) = app.evidence.as_ref().map(|(a, b)| (a.as_str(), b.as_str())).unwrap_or(("", "(none)"));
    frame.render_widget(
        Paragraph::new(text)
            .wrap(Wrap { trim: false })
            .scroll((app.evidence_scroll, 0))
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(format!(" evidence: {id} (esc to close) "))
                    .border_style(Style::default().fg(color(&app.config.theme.accent))),
            ),
        area,
    );
}

fn draw_input(frame: &mut Frame, app: &App, area: Rect) {
    let prompt = if app.sending { "sending… " } else { "› " };
    frame.render_widget(
        Paragraph::new(format!("{prompt}{}", app.input))
            .block(Block::default().borders(Borders::ALL).title(" message (enter to send, tab to switch, esc/q quit) ")),
        area,
    );
}

fn draw_status(frame: &mut Frame, app: &App, area: Rect) {
    let connection = if app.connected { "●" } else { "○" };
    let connection_style = if app.connected {
        Style::default().fg(color(&app.config.theme.ok))
    } else {
        Style::default().fg(color(&app.config.theme.err))
    };
    let mut spans = vec![
        Span::styled(connection.to_string(), connection_style),
        Span::raw(format!(" {} | cursor {}", app.status, app.last_cursor)),
    ];
    if let Some(error) = &app.config_error {
        spans.push(Span::styled(format!(" | {error}"), Style::default().fg(color(&app.config.theme.warn))));
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

/// The debrief pane: counts, the prose overview, trouble, and plans.
///
/// Absence is stated, never left blank. An empty region reads as "nothing to
/// report"; the states here mean "nothing was written", "nothing has run
/// yet", or "we could not ask", which are different facts.
fn draw_debrief(frame: &mut Frame, app: &App, area: Rect) {
    let focused = app.pane == Pane::Debrief;
    let border = if focused {
        Style::default().fg(color(&app.config.theme.accent))
    } else {
        Style::default()
    };
    let dim = Style::default().add_modifier(Modifier::DIM);

    let mut lines: Vec<Line> = Vec::new();

    let Some(debrief) = app.debrief.as_ref() else {
        let reason = app
            .debrief_error
            .clone()
            .unwrap_or_else(|| "waiting for the first supervisor tick".into());
        lines.push(Line::from(Span::styled(format!("no debrief yet — {reason}"), dim)));
        frame.render_widget(
            Paragraph::new(lines)
                .wrap(Wrap { trim: true })
                .block(Block::default().borders(Borders::ALL).title(" debrief ").border_style(border)),
            area,
        );
        return;
    };

    // Counts. Zeroes are rendered, never hidden: someone checking whether
    // anything is stuck needs to see "0 stuck", and a missing figure answers
    // nothing while looking the same as a zero.
    let c = &debrief.counts;
    lines.push(Line::from(vec![
        Span::raw(format!("{} sessions  ", c.total)),
        Span::styled(format!("{} working  ", c.working), Style::default().fg(color(&app.config.theme.ok))),
        Span::styled(format!("{} idle  ", c.idle), dim),
        Span::styled(
            format!("{} stuck  ", c.stuck),
            if c.stuck > 0 { Style::default().fg(color(&app.config.theme.warn)) } else { dim },
        ),
        Span::styled(
            format!("{} conflicted", c.conflicted),
            if c.conflicted > 0 { Style::default().fg(color(&app.config.theme.err)) } else { dim },
        ),
    ]));
    lines.push(Line::from(""));

    // The narrative, always attributed and always marked when stale, so it
    // cannot be mistaken for a measurement.
    match debrief.narrative.as_ref() {
        None => lines.push(Line::from(Span::styled("no overview generated yet", dim))),
        Some(narrative) => {
            let stale = narrative.inputs_hash != debrief.inputs_hash;
            for chunk in narrative.text.lines() {
                lines.push(Line::from(Span::styled(chunk.to_string(), dim)));
            }
            let meta = if stale {
                format!("— {} · describes an earlier state", narrative.model)
            } else {
                format!("— {}", narrative.model)
            };
            lines.push(Line::from(Span::styled(
                meta,
                if stale { Style::default().fg(color(&app.config.theme.warn)) } else { dim },
            )));
        }
    }
    lines.push(Line::from(""));

    // Trouble. "nothing flagged", never "all clear": the supervisor reports
    // what it detected and cannot observe that a session is healthy.
    lines.push(Line::from(Span::raw(format!("trouble ({})", debrief.trouble.len()))));
    if debrief.trouble.is_empty() {
        lines.push(Line::from(Span::styled("  nothing flagged", dim)));
    } else {
        for trouble in debrief.trouble.iter().take(10) {
            lines.push(Line::from(vec![
                Span::styled(format!("  {} ", trouble.kind.replace('_', " ")), Style::default().fg(color(&app.config.theme.warn))),
                Span::styled(trouble.detail.chars().take(60).collect::<String>(), dim),
            ]));
        }
    }
    lines.push(Line::from(""));

    // Plans. An empty list means different things depending on whether the
    // plans service answered, so the two are never rendered the same way.
    lines.push(Line::from(Span::raw(format!("plans ({})", debrief.plans.len()))));
    if let Some(error) = debrief.sources.plans.last_error.as_ref() {
        lines.push(Line::from(Span::styled(
            format!("  could not reach the plans service — {error}"),
            Style::default().fg(color(&app.config.theme.warn)),
        )));
    } else if debrief.plans.is_empty() {
        lines.push(Line::from(Span::styled("  no open plans", dim)));
    }
    for plan in debrief.plans.iter().take(10) {
        lines.push(Line::from(vec![
            Span::raw(format!("  {} ", plan.title.chars().take(44).collect::<String>())),
            Span::styled(format!("{}/{} ", plan.progress.done, plan.progress.total), dim),
            // The qualifier, never ownership: a repo match ties this plan to
            // every session in the repo, not to one of them.
            Span::styled(
                if plan.match_kind == "repo" { "in this repo".to_string() } else { plan.match_kind.clone() },
                dim,
            ),
        ]));
    }

    lines.push(Line::from(""));

    // Per-session rows. The merge-tree line is rendered for EVERY session,
    // including those never checked -- hiding it for those would make a
    // never-checked session look like a checked-and-clean one.
    lines.push(Line::from(Span::raw(format!("sessions ({})", debrief.sessions.len()))));
    for session in debrief.sessions.iter().take(12) {
        let status_style = match session.status.as_str() {
            "stuck" => Style::default().fg(color(&app.config.theme.warn)),
            "conflicted" => Style::default().fg(color(&app.config.theme.err)),
            _ => Style::default().fg(color(&app.config.theme.ok)),
        };
        let where_at = session.repo_name.clone().unwrap_or_else(|| "no repo".into());
        let idle = match session.idle_ms {
            // None means the session has produced NO messages at all --
            // different from "idle for 0ms", which would read as active.
            None => "no activity".to_string(),
            Some(ms) => format!("{}m idle", ms / 60_000),
        };
        lines.push(Line::from(vec![
            Span::styled("  ● ", status_style),
            Span::raw(format!("{} ", session.name.chars().take(24).collect::<String>())),
            Span::styled(
                format!("{} ", session.session_id.chars().take(8).collect::<String>()),
                dim,
            ),
            Span::styled(format!("({where_at}) {idle}"), dim),
        ]));
        if let Some(reason) = session.flagged_reason.as_ref() {
            lines.push(Line::from(Span::styled(
                format!("      {}", reason.chars().take(60).collect::<String>()),
                status_style,
            )));
        }
        lines.push(Line::from(Span::styled(
            match session.merge_tree_checked_at {
                None => "      merge-tree: not yet checked".to_string(),
                Some(_) => "      merge-tree: checked, no textual conflict".to_string(),
            },
            dim,
        )));
    }

    // The debrief is a cached read-model, not a live query, so its age is
    // part of reading it honestly -- a stale snapshot looks identical to a
    // fresh one without this.
    let age_secs = (now_millis() - debrief.generated_at).max(0) / 1000;
    let title = format!(" debrief ({} sessions, {}s ago) ", debrief.counts.total, age_secs);
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: true })
            .scroll((app.debrief_scroll, 0))
            .block(Block::default().borders(Borders::ALL).title(title).border_style(border)),
        area,
    );
}

/// Wall-clock now in unix ms. Only used for showing how old the cached
/// debrief snapshot is.
fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
