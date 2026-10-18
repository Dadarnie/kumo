// SPDX-License-Identifier: MIT
// Integration pollers — the Rust side of StripePoller / GithubPoller /
// VercelPoller / N8nPoller / ResendPoller / NotionPoller / CalcomPoller.
//
// Same endpoints, same first-run delays and intervals as the Swift pollers. Each
// one emits an `integration` event; the island owns the badge, the sound and the
// 60 s auto-clear, exactly as the Swift handlers do.
//
// Nothing is polled until its key exists in the Credential Manager, and no
// request goes anywhere the user has not configured.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::island::WINDOW_LABEL;
use crate::secrets;

const TIMEOUT: Duration = Duration::from_secs(10);

/// What the island receives. `event` is only set when something actually changed,
/// which is what drives the pill badge and the sound.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationUpdate {
    pub id: &'static str,
    pub data: Value,
    pub error: Option<String>,
    pub event: Option<IntegrationEvent>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationEvent {
    pub success: bool,
    pub label: String,
    pub detail: Option<String>,
}

fn emit(app: &AppHandle, update: IntegrationUpdate) {
    if !PAUSED.load(Ordering::Relaxed) && enabled(app, update.id) {
        let _ = app.emit_to(WINDOW_LABEL, "integration", update);
    }
}

fn client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()
}

/// Set from the tray's Pause item. While it is on, nothing reaches the network:
/// pausing Mimo has to mean pausing Mimo, not just hiding the island.
pub static PAUSED: AtomicBool = AtomicBool::new(false);

pub fn set_paused(on: bool) {
    PAUSED.store(on, Ordering::Relaxed);
    preferences_changed();
}

static PREFERENCES: LazyLock<tokio::sync::watch::Sender<u64>> =
    LazyLock::new(|| tokio::sync::watch::channel(0).0);

pub fn preferences_changed() {
    PREFERENCES.send_modify(|revision| *revision = revision.wrapping_add(1));
}

/// Preference changes cancel pending delays and in-flight requests. No timer is
/// retained while a module is disabled.
async fn until_changed<F: std::future::Future>(
    changes: &mut tokio::sync::watch::Receiver<u64>,
    work: F,
) -> Option<F::Output> {
    use std::future::{poll_fn, Future};
    use std::task::Poll;
    let mut changed = std::pin::pin!(changes.changed());
    let mut work = std::pin::pin!(work);
    poll_fn(|cx| {
        if changed.as_mut().poll(cx).is_ready() {
            return Poll::Ready(None);
        }
        work.as_mut().poll(cx).map(Some)
    })
    .await
}

/// Spawns every poller with the macOS delays and intervals.
pub fn start(app: AppHandle) {
    spawn(app.clone(), "integration_n8n", 3, 15, poll_n8n);
    spawn(app.clone(), "integration_vercel", 5, 30, poll_vercel);
    spawn(app.clone(), "integration_stripe", 6, 30, poll_stripe);
    spawn(app.clone(), "integration_resend", 6, 60, poll_resend);
    spawn(app.clone(), "integration_github", 7, 300, poll_github);
    spawn(app.clone(), "integration_calcom", 8, 300, poll_calcom);
    spawn(app, "integration_notion", 9, 300, poll_notion);
}

/// True when the user has this integration switched on in settings.
fn enabled(app: &AppHandle, id: &str) -> bool {
    app.try_state::<crate::Shared>()
        .map(|shared| {
            let settings = shared.settings.lock().unwrap();
            settings.integration_enabled(id)
        })
        .unwrap_or(false)
}

fn spawn<F, Fut>(app: AppHandle, id: &'static str, delay_secs: u64, every_secs: u64, poll: F)
where
    F: Fn(AppHandle) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send,
{
    tauri::async_runtime::spawn(async move {
        let mut changes = PREFERENCES.subscribe();
        let mut delay = Duration::from_secs(delay_secs);
        loop {
            if PAUSED.load(Ordering::Relaxed) || !enabled(&app, id) {
                if changes.changed().await.is_err() {
                    break;
                }
                delay = Duration::ZERO;
                continue;
            }
            if until_changed(&mut changes, tokio::time::sleep(delay))
                .await
                .is_none()
            {
                delay = Duration::ZERO;
                continue;
            }
            if PAUSED.load(Ordering::Relaxed) || !enabled(&app, id) {
                continue;
            }
            let completed = until_changed(&mut changes, poll(app.clone()))
                .await
                .is_some();
            delay = if completed {
                Duration::from_secs(every_secs)
            } else {
                Duration::ZERO
            };
        }
    });
}

/// One-shot refresh from the Refresh buttons in the island.
pub async fn poll_once(app: AppHandle, id: &str) {
    if PAUSED.load(Ordering::Relaxed) || !enabled(&app, id) {
        return;
    }
    let mut changes = PREFERENCES.subscribe();
    until_changed(&mut changes, async {
        match id {
            "integration_stripe" => poll_stripe(app).await,
            "integration_github" => poll_github(app).await,
            "integration_vercel" => poll_vercel(app).await,
            "integration_n8n" => poll_n8n(app).await,
            "integration_resend" => poll_resend(app).await,
            "integration_notion" => poll_notion(app).await,
            "integration_calcom" => poll_calcom(app).await,
            _ => {}
        }
    })
    .await;
}

/// Remembers the newest id per integration so an event fires once, not on every poll.
struct Seen(Mutex<std::collections::HashMap<&'static str, String>>);

static SEEN: std::sync::LazyLock<Seen> =
    std::sync::LazyLock::new(|| Seen(Mutex::new(std::collections::HashMap::new())));

/// Returns true the first time a given id is seen (and false on the very first
/// load, which only fills the card).
fn is_new(key: &'static str, id: &str) -> bool {
    let mut map = SEEN.0.lock().unwrap();
    match map.insert(key, id.to_string()) {
        Some(previous) => previous != id,
        None => false, // first poll: populate silently, like the Swift pollers
    }
}

fn status_error(code: u16, unauthorised_hint: &str) -> String {
    match code {
        401 => "Invalid API key (401)".into(),
        403 => unauthorised_hint.into(),
        _ => format!("API error {code}"),
    }
}

// ── Stripe ────────────────────────────────────────────────────────────────────

async fn poll_stripe(app: AppHandle) {
    let Some(key) = secrets::get("stripe-api-key") else {
        return;
    };
    let auth = format!(
        "Basic {}",
        crate::claude::base64_for(format!("{key}:").as_bytes())
    );
    let Some(http) = client() else {
        return;
    };

    let balance = http
        .get("https://api.stripe.com/v1/balance")
        .header("Authorization", &auth)
        .send()
        .await;

    let (amount, currency) = match balance {
        Ok(r) if r.status().is_success() => {
            let json: Value = r.json().await.unwrap_or(json!({}));
            let mut buckets: Vec<Value> = Vec::new();
            for k in ["available", "pending"] {
                if let Some(arr) = json.get(k).and_then(Value::as_array) {
                    buckets.extend(arr.iter().cloned());
                }
            }
            let currency = buckets
                .first()
                .and_then(|b| b.get("currency"))
                .and_then(Value::as_str)
                .unwrap_or("eur")
                .to_string();
            let amount: i64 = buckets
                .iter()
                .filter(|b| b.get("currency").and_then(Value::as_str) == Some(currency.as_str()))
                .filter_map(|b| b.get("amount").and_then(Value::as_i64))
                .sum();
            (amount, currency)
        }
        Ok(r) => {
            let code = r.status().as_u16();
            emit(
                &app,
                IntegrationUpdate {
                    id: "integration_stripe",
                    data: json!({}),
                    error: Some(status_error(
                        code,
                        "Use a secret key (sk_live_… not pk_live_…)",
                    )),
                    event: None,
                },
            );
            return;
        }
        Err(e) => {
            emit(
                &app,
                IntegrationUpdate {
                    id: "integration_stripe",
                    data: json!({}),
                    error: Some(format!("No connection: {e}")),
                    event: None,
                },
            );
            return;
        }
    };

    let charges = http
        .get("https://api.stripe.com/v1/charges?limit=12")
        .header("Authorization", &auth)
        .send()
        .await;
    let Ok(response) = charges else { return };
    if !response.status().is_success() {
        return;
    }
    let json: Value = response.json().await.unwrap_or(json!({}));
    let payments: Vec<Value> = json
        .get("data")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|c| {
                    let description = c
                        .get("description")
                        .and_then(Value::as_str)
                        .or_else(|| {
                            c.get("billing_details")
                                .and_then(|b| b.get("name"))
                                .and_then(Value::as_str)
                        })
                        .map(str::to_string);
                    Some(json!({
                        "id": c.get("id")?.as_str()?,
                        "amount": c.get("amount")?.as_i64()?,
                        "currency": c.get("currency")?.as_str()?,
                        "description": description,
                        "createdAt": c.get("created").and_then(Value::as_i64).unwrap_or(0) * 1000,
                        "status": c.get("status").and_then(Value::as_str).unwrap_or("succeeded"),
                        "refunded": c.get("refunded").and_then(Value::as_bool).unwrap_or(false),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();

    let newest = payments
        .first()
        .and_then(|p| p.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let event = if !newest.is_empty() && is_new("stripe", &newest) {
        let label = payments[0]
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                let cents = payments[0]
                    .get("amount")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                format!("{:.2}", cents as f64 / 100.0)
            });
        Some(IntegrationEvent {
            success: true,
            label,
            detail: None,
        })
    } else {
        None
    };

    let mut warnings = Vec::new();
    let recent = api_json(
        http.get("https://api.stripe.com/v1/events?limit=12")
            .header("Authorization", &auth),
        "Stripe events",
    )
    .await
    .unwrap_or_else(|error| {
        warnings.push(error);
        json!({})
    });
    let events:Vec<Value>=recent["data"].as_array().into_iter().flatten().take(12).map(|e|json!({"id":e["id"],"type":e["type"],"createdAt":e["created"].as_i64().unwrap_or(0)*1000})).collect();
    emit(
        &app,
        IntegrationUpdate {
            id: "integration_stripe",
            data: json!({ "balance": amount, "currency": currency, "payments": payments, "events":events, "warnings":warnings, "testMode":key.starts_with("sk_test_") }),
            error: None,
            event,
        },
    );
}

// ── GitHub ────────────────────────────────────────────────────────────────────

async fn api_json(request: reqwest::RequestBuilder, label: &str) -> Result<Value, String> {
    let response = request
        .send()
        .await
        .map_err(|_| format!("{label}: connection unavailable"))?;
    if !response.status().is_success() {
        return Err(format!(
            "{label}: HTTP {} (check key permissions)",
            response.status().as_u16()
        ));
    }
    response
        .json()
        .await
        .map_err(|_| format!("{label}: invalid response"))
}

fn github_request(http: &reqwest::Client, token: &str, path: &str) -> reqwest::RequestBuilder {
    http.get(format!("https://api.github.com{path}"))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Mimo")
}

/** Poll together without detached tasks, so the module's cancellation drops every read. */
async fn github_parallel<F: std::future::Future, const N: usize>(reads: [F; N]) -> [F::Output; N] {
    let mut reads = reads.map(Box::pin);
    let mut results: [Option<F::Output>; N] = std::array::from_fn(|_| None);
    std::future::poll_fn(move |cx| {
        for (index, read) in reads.iter_mut().enumerate() {
            if results[index].is_none() {
                if let std::task::Poll::Ready(value) = read.as_mut().poll(cx) {
                    results[index] = Some(value);
                }
            }
        }
        if results.iter().all(Option::is_some) {
            std::task::Poll::Ready(std::array::from_fn(|index| results[index].take().unwrap()))
        } else {
            std::task::Poll::Pending
        }
    })
    .await
}

fn github_calendar(value: &Value) -> Result<(Vec<Value>, u64), String> {
    let calendar = &value["data"]["viewer"]["contributionsCollection"]["contributionCalendar"];
    let Some(weeks) = calendar["weeks"].as_array() else {
        return Err("Contribution calendar: unavailable (check GitHub token permissions)".into());
    };
    let days: Vec<Value> = weeks
        .iter()
        .take(54)
        .flat_map(|week| week["contributionDays"].as_array().into_iter().flatten())
        .filter_map(|day| {
            let date = day["date"].as_str()?;
            if date.len() != 10
                || !date.bytes().enumerate().all(|(index, byte)| {
                    if index == 4 || index == 7 {
                        byte == b'-'
                    } else {
                        byte.is_ascii_digit()
                    }
                })
            {
                return None;
            }
            Some(json!({"date": date, "count": day["contributionCount"].as_u64()?}))
        })
        .collect();
    let total = calendar["totalContributions"]
        .as_u64()
        .unwrap_or_else(|| days.iter().filter_map(|day| day["count"].as_u64()).sum());
    Ok((days, total))
}

fn github_ci_state(status: Option<&Value>, checks: Option<&Value>) -> (&'static str, u64) {
    let legacy_count = status
        .and_then(|value| value["total_count"].as_u64())
        .unwrap_or(0);
    let runs = checks.and_then(|value| value["check_runs"].as_array());
    let check_count = checks
        .and_then(|value| value["total_count"].as_u64())
        .unwrap_or(0);
    let count = legacy_count + check_count;
    if legacy_count > 0
        && status.is_some_and(|value| matches!(value["state"].as_str(), Some("failure" | "error")))
    {
        return ("failure", count);
    }
    let mut pending = legacy_count > 0 && status.is_some_and(|value| value["state"] == "pending");
    let mut incomplete = false;
    for run in runs.into_iter().flatten() {
        if matches!(
            run["conclusion"].as_str(),
            Some("failure" | "cancelled" | "timed_out" | "action_required" | "stale")
        ) {
            return ("failure", count);
        }
        match run["status"].as_str() {
            Some("completed") => {
                if !matches!(
                    run["conclusion"].as_str(),
                    Some("success" | "neutral" | "skipped")
                ) {
                    incomplete = true;
                }
            }
            Some("queued" | "in_progress" | "waiting" | "pending" | "requested") => pending = true,
            _ => incomplete = true,
        }
    }
    if pending {
        return ("pending", count);
    }
    if status.is_none()
        || checks.is_none()
        || incomplete
        || runs.is_none()
        || check_count > runs.map_or(0, |values| values.len() as u64)
        || (legacy_count > 0 && !status.is_some_and(|value| value["state"] == "success"))
    {
        return ("unknown", count);
    }
    if count == 0 {
        ("none", 0)
    } else {
        ("success", count)
    }
}

async fn github_branch_checks(
    http: &reqwest::Client,
    token: &str,
    repo: Option<&Value>,
) -> Option<(Value, Vec<String>)> {
    let repo = repo?;
    let name = repo["full_name"].as_str()?;
    let branch = repo["default_branch"].as_str()?;
    let mut warnings = Vec::new();
    let commits = api_json(
        github_request(http, token, &format!("/repos/{name}/commits"))
            .query(&[("sha", branch), ("per_page", "1")]),
        "Default branch",
    )
    .await;
    let sha = match commits {
        Ok(value) => value[0]["sha"].as_str().map(str::to_owned),
        Err(error) => {
            warnings.push(error);
            None
        }
    };
    let mut state = "unknown";
    let mut count = 0;
    let mut runs = Vec::new();
    if let Some(sha) = &sha {
        let [status, checks] = github_parallel([
            api_json(
                github_request(http, token, &format!("/repos/{name}/commits/{sha}/status")),
                "Commit statuses",
            ),
            api_json(
                github_request(
                    http,
                    token,
                    &format!("/repos/{name}/commits/{sha}/check-runs"),
                )
                .query(&[("per_page", "100")]),
                "Branch checks",
            ),
        ])
        .await;
        let status = status.map_err(|error| warnings.push(error)).ok();
        let checks = checks.map_err(|error| warnings.push(error)).ok();
        (state, count) = github_ci_state(status.as_ref(), checks.as_ref());
        runs=checks.as_ref().and_then(|value|value["check_runs"].as_array()).into_iter().flatten().take(100).map(|run|json!({
            "id":run["id"],"name":run["name"],"status":run["status"],"conclusion":run["conclusion"],"url":run["html_url"]
        })).collect();
    }
    Some((
        json!({"repo": name, "branch": branch, "sha":sha,"runs":runs,"state": state, "checkCount": count,
        "updatedAt": repo["pushed_at"], "url": format!("https://github.com/{name}/actions")}),
        warnings,
    ))
}

async fn poll_github(app: AppHandle) {
    let Some(token) = secrets::get("github-token") else {
        return;
    };
    let Some(http) = client() else { return };
    let get = |path: &str| github_request(&http, &token, path);
    let user = match api_json(get("/user"), "GitHub").await {
        Ok(value) => value,
        Err(error) => {
            emit(
                &app,
                IntegrationUpdate {
                    id: "integration_github",
                    data: json!({}),
                    error: Some(error),
                    event: None,
                },
            );
            return;
        }
    };
    let login = user["login"].as_str().unwrap_or("");
    if login.is_empty() || !login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return;
    }
    let search = |kind: &str, qualifier: &str| {
        get("/search/issues").query(&[
            ("q", format!("is:{kind} is:open {qualifier}:{login}")),
            ("sort", "updated".into()),
            ("per_page", "20".into()),
        ])
    };
    // All reads remain inside the poll future: disabling the integration cancels them together.
    let [repos, prs, reviews, issues, events, calendar] = github_parallel([
        api_json(get("/user/repos?per_page=30&sort=pushed&affiliation=owner,collaborator,organization_member"), "Repositories"),
        api_json(search("pr", "author"), "Pull requests"),
        api_json(search("pr", "review-requested"), "Review requests"),
        api_json(search("issue", "assignee"), "Assigned issues"),
        api_json(get(&format!("/users/{login}/events?per_page=20")), "Activity"),
        api_json(http.post("https://api.github.com/graphql").bearer_auth(&token).header("User-Agent", "Mimo")
            .json(&json!({"query": "query { viewer { contributionsCollection { contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } } } } }"})), "Contribution calendar")
    ]).await;
    let mut warnings = Vec::new();
    let repos = repos.unwrap_or_else(|error| {
        warnings.push(error);
        json!([])
    });
    let prs = prs.unwrap_or_else(|error| {
        warnings.push(error);
        json!({})
    });
    let reviews = reviews.unwrap_or_else(|error| {
        warnings.push(error);
        json!({})
    });
    let issues = issues.unwrap_or_else(|error| {
        warnings.push(error);
        json!({})
    });
    let events = events.unwrap_or_else(|error| {
        warnings.push(error);
        json!([])
    });
    let (contributions, total_contributions) = calendar
        .and_then(|value| github_calendar(&value))
        .unwrap_or_else(|error| {
            warnings.push(error);
            (Vec::new(), 0)
        });
    let ci_repos: Vec<&Value> = repos.as_array().into_iter().flatten().take(3).collect();
    let [first, second, third] = github_parallel([
        github_branch_checks(&http, &token, ci_repos.first().copied()),
        github_branch_checks(&http, &token, ci_repos.get(1).copied()),
        github_branch_checks(&http, &token, ci_repos.get(2).copied()),
    ])
    .await;
    let checks: Vec<Value> = [first, second, third]
        .into_iter()
        .flatten()
        .map(|(row, errors)| {
            warnings.extend(errors);
            row
        })
        .collect();
    let repository_rows: Vec<Value> = repos.as_array().into_iter().flatten().take(30).map(|repo| json!({
        "id": repo["id"], "name": repo["full_name"], "url": repo["html_url"], "updatedAt": repo["pushed_at"],
        "stars": repo["stargazers_count"], "issues": repo["open_issues_count"], "private": repo["private"],
        "branch": repo["default_branch"] })).collect();
    let clean_issues = |value: &Value| {
        value["items"].as_array().into_iter().flatten().take(20).map(|item| json!({
        "id": item["id"], "title": item["title"], "number": item["number"], "url": item["html_url"],
        "repo": item["repository_url"].as_str().and_then(|url| url.strip_prefix("https://api.github.com/repos/")),
        "state": item["state"], "updatedAt": item["updated_at"], "author": item["user"]["login"], "draft": item["draft"] })).collect::<Vec<Value>>()
    };
    let activity: Vec<Value> = events.as_array().into_iter().flatten().take(20).map(|event| json!({
        "id": event["id"], "type": event["type"], "repo": event["repo"]["name"], "actor": event["actor"]["login"],
        "createdAt": event["created_at"], "url": event["payload"]["pull_request"]["html_url"].as_str()
            .or_else(|| event["payload"]["issue"]["html_url"].as_str()).map(str::to_owned)
            .unwrap_or_else(|| format!("https://github.com/{}", event["repo"]["name"].as_str().unwrap_or(login))) })).collect();
    let event = activity.first().and_then(|value| {
        let id = value["id"].as_str()?;
        if !is_new("github-activity", id) {
            return None;
        }
        Some(IntegrationEvent {
            success: true,
            label: value["repo"].as_str().unwrap_or("GitHub activity").into(),
            detail: value["type"].as_str().map(str::to_owned),
        })
    });
    let stars: i64 = repository_rows
        .iter()
        .filter_map(|repo| repo["stars"].as_i64())
        .sum();
    emit(
        &app,
        IntegrationUpdate {
            id: "integration_github",
            data: json!({
                "login": login, "totalRepos": user["public_repos"].as_i64().unwrap_or(0) + user["owned_private_repos"].as_i64().unwrap_or(0),
                "totalStars": stars, "repositories": repository_rows, "pullRequests": clean_issues(&prs), "reviews": clean_issues(&reviews),
                "issues": clean_issues(&issues), "activity": activity, "openPullRequests": prs["total_count"], "reviewCount": reviews["total_count"],
                "contributions": contributions, "totalContributions": total_contributions, "checks": checks, "warnings": warnings
            }),
            error: None,
            event,
        },
    );
}

// ── Vercel ────────────────────────────────────────────────────────────────────

async fn poll_vercel(app: AppHandle) {
    let Some(token) = secrets::get("vercel-token") else {
        return;
    };
    let Some(http) = client() else {
        return;
    };
    let response = http
        .get("https://api.vercel.com/v7/deployments")
        .query(&[("limit", "5")])
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .send()
        .await;
    let Ok(response) = response else { return };
    if !response.status().is_success() {
        emit(
            &app,
            IntegrationUpdate {
                id: "integration_vercel",
                data: json!({}),
                error: Some(status_error(
                    response.status().as_u16(),
                    "Token lacks access",
                )),
                event: None,
            },
        );
        return;
    }
    let json: Value = response.json().await.unwrap_or(json!({}));
    let deployments: Vec<Value> = json
        .get("deployments")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|d| {
                    let state = d.get("state").or_else(||d.get("readyState"))?.as_str()?;
                    let meta = d.get("meta");
                    let pick = |keys: [&str; 3]| {
                        meta.and_then(|m| keys.iter().find_map(|k| m.get(*k).and_then(Value::as_str)))
                            .map(str::to_string)
                    };
                    Some(json!({
                        "id": d.get("uid").or_else(||d.get("id"))?.as_str()?,
                        "projectId": d.get("projectId"),
                        "projectName": d.get("name")?.as_str()?,
                        "url": d.get("url").and_then(Value::as_str).unwrap_or(""),
                        "inspectorUrl": d.get("inspectorUrl").and_then(Value::as_str).unwrap_or(""),
                        "state": state,
                        "createdAt": d.get("createdAt").and_then(Value::as_f64).unwrap_or(0.0),
                        "commitMessage": pick(["githubCommitMessage", "gitlabCommitMessage", "bitbucketCommitMessage"]),
                        "branch": pick(["githubCommitRef", "gitlabCommitRef", "bitbucketBranch"]),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();

    let event = deployments.first().and_then(|latest| {
        if !["READY", "ERROR", "CANCELED"].contains(&latest.get("state")?.as_str()?) {
            return None;
        }
        let id = latest.get("id")?.as_str()?;
        if !is_new("vercel", id) {
            return None;
        }
        let success = latest.get("state")?.as_str()? == "READY";
        Some(IntegrationEvent {
            success,
            label: latest.get("projectName")?.as_str()?.to_string(),
            detail: None,
        })
    });

    emit(
        &app,
        IntegrationUpdate {
            id: "integration_vercel",
            data: json!({ "deployments": deployments }),
            error: None,
            event,
        },
    );
}

// ── Resend ────────────────────────────────────────────────────────────────────

async fn poll_resend(app: AppHandle) {
    let Some(key) = secrets::get("resend-api-key") else {
        return;
    };
    let Some(http) = client() else {
        return;
    };
    let response = http
        .get("https://api.resend.com/emails?limit=100")
        .header("Authorization", format!("Bearer {key}"))
        .header("Accept", "application/json")
        .send()
        .await;
    let Ok(response) = response else { return };
    if !response.status().is_success() {
        emit(
            &app,
            IntegrationUpdate {
                id: "integration_resend",
                data: json!({}),
                error: Some(status_error(response.status().as_u16(), "Key lacks access")),
                event: None,
            },
        );
        return;
    }
    let json: Value = response.json().await.unwrap_or(json!({}));
    let total = json
        .get("total")
        .or_else(|| json.get("count"))
        .and_then(Value::as_i64);
    let emails: Vec<Value> = json
        .get("data")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .take(5)
                .filter_map(|e| {
                    let to = match e.get("to") {
                        Some(Value::Array(a)) => a.clone(),
                        Some(Value::String(s)) => vec![Value::String(s.clone())],
                        _ => vec![],
                    };
                    Some(json!({
                        "id": e.get("id")?.as_str()?,
                        "to": to,
                        "subject": e.get("subject").and_then(Value::as_str).unwrap_or(""),
                        "createdAt": e.get("created_at").and_then(Value::as_str).unwrap_or(""),
                        "lastEvent": e.get("last_event").and_then(Value::as_str).unwrap_or(""),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();

    emit(
        &app,
        IntegrationUpdate {
            id: "integration_resend",
            data: json!({ "emails": emails, "total": total }),
            error: None,
            event: None,
        },
    );
}

// ── Notion ────────────────────────────────────────────────────────────────────

async fn poll_notion(app: AppHandle) {
    let Some(token) = secrets::get("notion-api-key") else {
        return;
    };
    let Some(http) = client() else {
        return;
    };
    let response = http
        .post("https://api.notion.com/v1/search")
        .header("Authorization", format!("Bearer {token}"))
        .header("Notion-Version", "2022-06-28")
        .header("Content-Type", "application/json")
        .json(&json!({
            "sort": { "direction": "descending", "timestamp": "last_edited_time" },
            "page_size": 3
        }))
        .send()
        .await;
    let Ok(response) = response else { return };
    if !response.status().is_success() {
        emit(
            &app,
            IntegrationUpdate {
                id: "integration_notion",
                data: json!({}),
                error: Some(status_error(
                    response.status().as_u16(),
                    "Integration lacks access",
                )),
                event: None,
            },
        );
        return;
    }
    let json: Value = response.json().await.unwrap_or(json!({}));
    let pages: Vec<Value> = json
        .get("results")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(parse_notion_page).collect())
        .unwrap_or_default();

    emit(
        &app,
        IntegrationUpdate {
            id: "integration_notion",
            data: json!({ "pages": pages }),
            error: None,
            event: None,
        },
    );
}

fn parse_notion_page(obj: &Value) -> Option<Value> {
    let id = obj.get("id")?.as_str()?;
    let is_database = obj.get("object").and_then(Value::as_str) == Some("database");

    let mut title = "Untitled".to_string();
    if is_database {
        if let Some(text) = obj
            .get("title")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|t| t.get("plain_text"))
            .and_then(Value::as_str)
        {
            if !text.is_empty() {
                title = text.to_string();
            }
        }
    } else if let Some(props) = obj.get("properties").and_then(Value::as_object) {
        for prop in props.values() {
            if prop.get("type").and_then(Value::as_str) != Some("title") {
                continue;
            }
            if let Some(text) = prop
                .get("title")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(|t| t.get("plain_text"))
                .and_then(Value::as_str)
            {
                if !text.is_empty() {
                    title = text.to_string();
                    break;
                }
            }
        }
    }

    let emoji = obj
        .get("icon")
        .filter(|i| i.get("type").and_then(Value::as_str) == Some("emoji"))
        .and_then(|i| i.get("emoji"))
        .and_then(Value::as_str);

    Some(json!({
        "id": id,
        "title": title,
        "emoji": emoji,
        "lastEditedAt": obj.get("last_edited_time").and_then(Value::as_str)?,
        "url": obj.get("url").and_then(Value::as_str).unwrap_or("https://notion.so"),
    }))
}

// ── Cal.com ───────────────────────────────────────────────────────────────────

async fn poll_calcom(app: AppHandle) {
    let Some(key) = secrets::get("calcom-api-key") else {
        return;
    };
    let Some(http) = client() else {
        return;
    };
    let response = http
        .get("https://api.cal.com/v2/bookings?status=upcoming")
        .header("Authorization", format!("Bearer {key}"))
        .header("cal-api-version", "2024-08-13")
        .send()
        .await;
    let Ok(response) = response else { return };
    if !response.status().is_success() {
        emit(
            &app,
            IntegrationUpdate {
                id: "integration_calcom",
                data: json!({}),
                error: Some(status_error(response.status().as_u16(), "Key lacks access")),
                event: None,
            },
        );
        return;
    }
    let json: Value = response.json().await.unwrap_or(json!({}));
    let bookings: Vec<Value> = json
        .get("data")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|b| {
                    let start = b
                        .get("start")
                        .or_else(|| b.get("startTime"))
                        .and_then(Value::as_str)?;
                    let attendee = b.get("attendees").and_then(Value::as_array).and_then(|a| a.first());
                    let notes = b
                        .get("responses")
                        .and_then(|r| r.get("notes"))
                        .and_then(|n| n.get("value"))
                        .and_then(Value::as_str)
                        .or_else(|| b.get("description").and_then(Value::as_str))
                        .filter(|s| !s.is_empty());
                    Some(json!({
                        "id": b.get("id").map(|v| v.to_string()).unwrap_or_default(),
                        "title": b.get("title").and_then(Value::as_str).unwrap_or("Meeting"),
                        "start": start,
                        "status": b.get("status").and_then(Value::as_str).unwrap_or("accepted"),
                        "attendeeName": attendee.and_then(|a| a.get("name")).and_then(Value::as_str),
                        "attendeeEmail": attendee.and_then(|a| a.get("email")).and_then(Value::as_str),
                        "attendeeNotes": notes,
                    }))
                })
                .collect()
        })
        .unwrap_or_default();

    emit(
        &app,
        IntegrationUpdate {
            id: "integration_calcom",
            data: json!({ "bookings": bookings }),
            error: None,
            event: None,
        },
    );
}

// ── n8n ───────────────────────────────────────────────────────────────────────

async fn poll_n8n(app: AppHandle) {
    let (Some(key), Some(base)) = (secrets::get("n8n-api-key"), secrets::get("n8n-url")) else {
        return;
    };
    if secrets::validate("n8n-url", &base).is_err() {
        return;
    }
    let base = base.trim_end_matches('/');
    let Some(http) = client() else { return };
    let get = |path: &str| {
        http.get(format!("{base}{path}"))
            .header("X-N8N-API-KEY", &key)
            .header("Accept", "application/json")
    };
    let mut warnings = Vec::new();
    let list = match api_json(
        get("/api/v1/executions?limit=20&includeData=false"),
        "Executions",
    )
    .await
    {
        Ok(value) => value,
        Err(_) => match api_json(
            get("/rest/executions?limit=20&includeData=false"),
            "Executions",
        )
        .await
        {
            Ok(value) => value,
            Err(error) => {
                emit(
                    &app,
                    IntegrationUpdate {
                        id: "integration_n8n",
                        data: json!({}),
                        error: Some(error),
                        event: None,
                    },
                );
                return;
            }
        },
    };
    let flows = api_json(get("/api/v1/workflows?limit=30"), "Workflows")
        .await
        .unwrap_or_else(|error| {
            warnings.push(error);
            json!({})
        });
    let workflows:Vec<Value>=flows["data"].as_array().into_iter().flatten().take(30).map(|w|json!({"id":w["id"],"name":w["name"],"active":w["active"],"updatedAt":w["updatedAt"]})).collect();
    let executions:Vec<Value>=list.get("data").unwrap_or(&list).as_array().into_iter().flatten().take(20).map(|run|{
        let workflow=workflows.iter().find(|w|w["id"]==run["workflowId"]);json!({"id":run["id"],"workflowId":run["workflowId"],"name":workflow.map(|w|w["name"].clone()).unwrap_or(json!("Workflow")),"status":run["status"],"startedAt":run["startedAt"],"stoppedAt":run["stoppedAt"],"mode":run["mode"]})
    }).collect();
    let event = executions.first().and_then(|run| {
        let id = run["id"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| run["id"].as_u64().map(|id| id.to_string()))?;
        let state = run["status"].as_str()?;
        if !["success", "error", "crashed", "canceled", "failed"].contains(&state)
            || !is_new("n8n", &id)
        {
            return None;
        }
        Some(IntegrationEvent {
            success: state == "success",
            label: run["name"].as_str().unwrap_or("Workflow").into(),
            detail: Some(state.into()),
        })
    });
    emit(
        &app,
        IntegrationUpdate {
            id: "integration_n8n",
            data: json!({"workflow":executions.first().and_then(|run|run["name"].as_str()).unwrap_or("Workflow"),"status":executions.first().and_then(|run|run["status"].as_str()).unwrap_or("idle"),"executions":executions,"workflows":workflows,"warnings":warnings}),
            error: None,
            event,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_default_branch_checks_require_both_api_readings() {
        let empty_status = json!({"total_count": 0, "state": "pending"});
        let empty_checks = json!({"total_count": 0, "check_runs": []});
        assert_eq!(
            github_ci_state(Some(&empty_status), Some(&empty_checks)),
            ("none", 0)
        );
        let passed = json!({"total_count": 3, "check_runs": [
            {"status": "completed", "conclusion": "success"},
            {"status": "completed", "conclusion": "neutral"},
            {"status": "completed", "conclusion": "skipped"}
        ]});
        assert_eq!(
            github_ci_state(Some(&empty_status), Some(&passed)),
            ("success", 3)
        );
        assert_eq!(github_ci_state(None, Some(&passed)), ("unknown", 3));
        assert_eq!(github_ci_state(Some(&empty_status), None), ("unknown", 0));
        let running = json!({"total_count": 1, "check_runs": [{"status": "in_progress", "conclusion": null}]});
        assert_eq!(
            github_ci_state(Some(&empty_status), Some(&running)),
            ("pending", 1)
        );
        let failed = json!({"total_count": 1, "check_runs": [{"status": "completed", "conclusion": "failure"}]});
        assert_eq!(
            github_ci_state(Some(&empty_status), Some(&failed)),
            ("failure", 1)
        );
        let truncated = json!({"total_count": 2, "check_runs": [{"status": "completed", "conclusion": "success"}]});
        assert_eq!(
            github_ci_state(Some(&empty_status), Some(&truncated)),
            ("unknown", 2)
        );
    }

    #[test]
    fn github_calendar_keeps_reported_zeroes_and_rejects_unreadable_data() {
        let response = json!({"data": {"viewer": {"contributionsCollection": {"contributionCalendar": {
            "totalContributions": 3, "weeks": [{"contributionDays": [
                {"date": "2026-10-09", "contributionCount": 0},
                {"date": "2026-10-10", "contributionCount": 3},
                {"date": "invalid", "contributionCount": 5}
            ]}]
        }}}}});
        let (days, total) = github_calendar(&response).unwrap();
        assert_eq!(total, 3);
        assert_eq!(days.len(), 2);
        assert_eq!(days[0]["count"], 0);
        assert!(github_calendar(&json!({"errors": [{"message": "Forbidden"}]})).is_err());
    }

    #[test]
    fn preference_changes_cancel_and_drop_in_flight_work() {
        struct Cleanup(std::sync::Arc<AtomicBool>);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Relaxed);
            }
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (sender, mut changes) = tokio::sync::watch::channel(0);
            let released = std::sync::Arc::new(AtomicBool::new(false));
            let cleanup = Cleanup(released.clone());
            let work = async move {
                let _cleanup = cleanup;
                std::future::pending::<()>().await;
            };
            tokio::spawn(async move {
                tokio::task::yield_now().await;
                sender.send_modify(|revision| *revision += 1);
            });
            assert_eq!(until_changed(&mut changes, work).await, None);
            assert!(released.load(Ordering::Relaxed));
        });
    }
}
