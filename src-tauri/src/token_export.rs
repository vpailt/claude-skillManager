//! On-demand exports of the token consumption: an HTML report in the AlmaviaCX
//! charter and an Excel workbook. Both are built from `token_usage::load`
//! with the filter the tab is showing.
//!
//! The HTML charter is not shipped with the app: it is read from the
//! `acx-cr-html` skill of the installed `acx-cl-library` plugin (highest semver
//! version), so the report follows charter updates without a new release.

use crate::config;
use crate::error::{Error, Result};
use crate::token_usage::{
    self, aggregate, day_key, fmt_tokens, month_key, week_key, By, Dataset, Filter, TokenBucket,
};
use base64::Engine;
use chrono::Local;
use regex::Regex;
use std::fs;
use std::path::{Path, PathBuf};

const ACX_ASSETS: [&str; 4] = [
    "charte-acx.css",
    "logo-almaviacx.svg",
    "favicon-96x96.png",
    "sommaire-flottant.js",
];

// ============================================================
// Shared helpers
// ============================================================

fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            c => out.push(c),
        }
    }
    out
}

/// `12 345` — French thousands separator.
fn thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(' ');
        }
        out.push(c);
    }
    out
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(Error::Other(format!(
            "impossible d'écrire {} (fichier ouvert dans un autre programme ?) : {e}",
            path.display()
        )));
    }
    Ok(())
}

// ============================================================
// HTML, AlmaviaCX charter
// ============================================================

fn semver_of(name: &str) -> Option<Vec<u64>> {
    name.split('.').map(|p| p.parse().ok()).collect()
}

/// Assets of the `acx-cr-html` skill, from the highest installed version that
/// carries all of them. Versions compare numerically (`10.0.0` > `4.1.1`).
fn acx_assets_dir() -> Result<PathBuf> {
    let library = config::plugins_cache_dir()
        .join("acx-cl-marketplace")
        .join("acx-cl-library");
    let mut versions: Vec<(Vec<u64>, PathBuf)> = fs::read_dir(&library)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| Some((semver_of(&e.file_name().to_string_lossy())?, e.path())))
        .collect();
    versions.sort_by(|a, b| b.0.cmp(&a.0));
    versions
        .into_iter()
        .map(|(_, dir)| dir.join("skills").join("acx-cr-html").join("assets"))
        .find(|assets| ACX_ASSETS.iter().all(|f| assets.join(f).is_file()))
        .ok_or_else(|| {
            Error::NotFound(format!(
                "skill acx-cr-html introuvable sous {} : installez le plugin acx-cl-library \
                 pour exporter le rapport à la charte AlmaviaCX",
                library.display()
            ))
        })
}

fn acx_num(n: u64) -> String {
    // acx-quand is the charter's only plain mono, tabular, no-wrap cell style:
    // acx-mono would draw a code badge around every figure.
    format!(r#"<td class="acx-quand">{}</td>"#, fmt_tokens(n))
}

fn acx_limit_cell(count: u64) -> String {
    match count {
        0 => String::new(),
        1 => r#"<span class="acx-puce est-bloquant">1 limite</span>"#.to_string(),
        n => format!(r#"<span class="acx-puce est-bloquant">{n} limites</span>"#),
    }
}

const ACX_USAGE_HEADERS: [&str; 6] = [
    "Appels",
    "Output",
    "Cache écrit",
    "Cache lu",
    "Output + cache écrit",
    "Limites",
];

fn acx_usage_cells(b: &TokenBucket) -> String {
    format!(
        r#"{}{}{}{}<td class="acx-quand"><strong>{}</strong></td><td class="acx-etat">{}</td>"#,
        format!(r#"<td class="acx-quand">{}</td>"#, thousands(b.calls)),
        acx_num(b.output),
        acx_num(b.cache_write),
        acx_num(b.cache_read),
        fmt_tokens(b.weight()),
        acx_limit_cell(b.limits)
    )
}

fn acx_table(headers: &[&str], rows: &[String]) -> String {
    let head: String = headers
        .iter()
        .map(|h| format!("<th>{}</th>", esc(h)))
        .collect();
    format!(
        r#"<div class="acx-table-wrap"><table><thead><tr>{head}</tr></thead><tbody>{}</tbody></table></div>"#,
        rows.concat()
    )
}

fn acx_period_rows(items: &[TokenBucket]) -> Vec<String> {
    items
        .iter()
        .map(|b| {
            format!(
                r#"<tr data-p="{l}"><td class="acx-quand">{p}</td><td>{l}</td>{c}</tr>"#,
                l = esc(&b.label),
                p = esc(&b.period),
                c = acx_usage_cells(b)
            )
        })
        .collect()
}

/// Keep the buckets of the `n` most recent periods.
fn last_periods(items: Vec<TokenBucket>, n: usize) -> Vec<TokenBucket> {
    let mut periods: Vec<&str> = items.iter().map(|b| b.period.as_str()).collect();
    periods.sort_unstable_by(|a, b| b.cmp(a));
    periods.dedup();
    let keep: std::collections::HashSet<String> =
        periods.into_iter().take(n).map(str::to_string).collect();
    items.into_iter().filter(|b| keep.contains(&b.period)).collect()
}

const ACX_FILTER_SCRIPT: &str = r#"
(function () {
  var sel = document.getElementById('acx-filtre-projet');
  if (!sel) { return; }
  sel.addEventListener('change', function () {
    var p = sel.value;
    document.querySelectorAll('tr[data-p]').forEach(function (tr) {
      tr.hidden = p !== '' && tr.getAttribute('data-p') !== p;
    });
  });
})();
"#;

fn period_label(filter: &Filter, data: &Dataset) -> String {
    let fr = |day: &str| -> String {
        let p: Vec<&str> = day.split('-').collect();
        if p.len() == 3 {
            format!("{}/{}/{}", p[2], p[1], p[0])
        } else {
            day.to_string()
        }
    };
    let from = if filter.from.is_empty() {
        data.rows.first().map(|r| day_key(&r.when))
    } else {
        Some(filter.from.clone())
    };
    let to = if filter.to.is_empty() {
        day_key(&Local::now())
    } else {
        filter.to.clone()
    };
    match from {
        Some(f) => format!("Du {} au {}", fr(&f), fr(&to)),
        None => format!("Jusqu'au {}", fr(&to)),
    }
}

fn build_acx_body(filter: &Filter, data: &Dataset) -> String {
    let now = Local::now();
    let this_month = month_key(&now);
    let db = token_usage::db_path().to_string_lossy().to_string();

    let projects = aggregate(data, By::Project);
    let mut sessions = aggregate(data, By::Session);
    sessions.truncate(100);
    let months = aggregate(data, By::Month);
    let weeks = aggregate(data, By::Week);
    let mut days = aggregate(data, By::Day);
    // Without a start date the whole history would be listed day by day.
    let days_title = if filter.from.is_empty() {
        days = last_periods(days, 30);
        "Par jour, sur les 30 derniers jours d'activité"
    } else {
        "Par jour"
    };

    let total_weight: u64 = projects.iter().map(TokenBucket::weight).sum();
    let total_calls: u64 = projects.iter().map(|b| b.calls).sum();
    let month_items: Vec<&TokenBucket> =
        months.iter().filter(|b| b.period == this_month).collect();
    let month_weight: u64 = month_items.iter().map(|b| b.weight()).sum();
    let month_top = month_items.iter().max_by_key(|b| b.weight());
    let top = projects.first();
    let last_limit = data.limits.last();
    let session_count = data
        .rows
        .iter()
        .map(|r| r.session_id.as_str())
        .collect::<std::collections::HashSet<_>>()
        .len();

    let cards = [
        (
            "",
            "Mois en cours".to_string(),
            format!("{} en {}", fmt_tokens(month_weight), now.format("%m/%Y")),
            match month_top {
                Some(b) => format!("Premier poste : {}.", esc(&b.label)),
                None => "Aucune activité ce mois-ci.".to_string(),
            },
        ),
        (
            "",
            "Projet le plus consommateur".to_string(),
            top.map(|b| esc(&b.label)).unwrap_or_else(|| "-".into()),
            match top {
                Some(b) if total_weight > 0 => format!(
                    "{} tokens, soit {} % du total.",
                    fmt_tokens(b.weight()),
                    (100.0 * b.weight() as f64 / total_weight as f64).round()
                ),
                _ => String::new(),
            },
        ),
        (
            if data.limits.is_empty() { "" } else { "est-alerte" },
            "Limites atteintes".to_string(),
            match data.limits.len() {
                0 => "Aucune limite atteinte".to_string(),
                1 => "1 limite".to_string(),
                n => format!("{n} limites"),
            },
            match last_limit {
                Some(l) => format!("Dernière le {} sur {}.", esc(&l.at), esc(&l.label)),
                None => "Sur toute la période suivie.".to_string(),
            },
        ),
    ];
    let cards_html: String = cards
        .iter()
        .map(|(cls, label, title, text)| {
            format!(
                r#"<div class="acx-carte {cls}"><p class="acx-carte-label">{label}</p><p class="acx-carte-titre">{title}</p><p>{text}</p></div>"#
            )
        })
        .collect();

    let project_rows: Vec<String> = projects
        .iter()
        .map(|b| {
            format!(
                r#"<tr data-p="{l}"><td>{l}</td>{c}</tr>"#,
                l = esc(&b.label),
                c = acx_usage_cells(b)
            )
        })
        .collect();
    let session_rows: Vec<String> = sessions
        .iter()
        .map(|b| {
            format!(
                r#"<tr data-p="{l}"><td class="acx-quand">{s}</td><td>{l}</td><td class="acx-quand">{d} min</td><td>{t}</td>{c}</tr>"#,
                l = esc(&b.label),
                s = esc(&b.start),
                d = b.duration_min,
                t = esc(&b.title),
                c = acx_usage_cells(b)
            )
        })
        .collect();
    let limit_rows: Vec<String> = data
        .limits
        .iter()
        .rev()
        .map(|l| {
            format!(
                r#"<tr data-p="{lab}"><td class="acx-quand">{at}</td><td>{lab}</td><td>{t}</td><td>{m}</td></tr>"#,
                lab = esc(&l.label),
                at = esc(&l.at),
                t = esc(&l.title),
                m = esc(&l.text)
            )
        })
        .collect();

    let mut labels: Vec<&str> = projects.iter().map(|b| b.label.as_str()).collect();
    labels.sort_by_key(|l| l.to_lowercase());
    let options: String = labels
        .iter()
        .map(|l| format!(r#"<option value="{v}">{v}</option>"#, v = esc(l)))
        .collect();

    fn with_period(first: &str) -> Vec<&str> {
        let mut h = vec![first, "Projet"];
        h.extend(ACX_USAGE_HEADERS);
        h
    }
    let mut project_headers = vec!["Projet"];
    project_headers.extend(ACX_USAGE_HEADERS);
    let mut session_headers = vec!["Début", "Projet", "Durée", "Première demande"];
    session_headers.extend(ACX_USAGE_HEADERS);

    let limits_html = if limit_rows.is_empty() {
        r#"<div class="acx-encadre est-fait"><span class="acx-encadre-titre">Aucune limite</span><p>Aucune limite d'usage n'a été atteinte sur la période suivie.</p></div>"#.to_string()
    } else {
        acx_table(&["Quand", "Projet", "Session", "Message"], &limit_rows)
    };

    let scope_note = if filter.project.is_empty() {
        "Le filtre agit sur tous les tableaux ; les cartes ci-dessus portent toujours sur l'ensemble."
            .to_string()
    } else {
        format!(
            "Rapport restreint au projet {}. Le filtre agit sur tous les tableaux.",
            esc(&filter.project)
        )
    };

    let sections: Vec<(&str, &str, String)> = vec![
        (
            "essentiel",
            "L'essentiel",
            format!(
                r#"<div class="acx-cartes">{cards_html}</div><div class="acx-encadre"><span class="acx-encadre-titre">Filtrer les tableaux</span><p><label for="acx-filtre-projet">Projet</label> <select id="acx-filtre-projet"><option value="">Tous les projets</option>{options}</select></p><p>{scope_note}</p></div>"#
            ),
        ),
        (
            "projets",
            "Consommation par projet",
            acx_table(&project_headers, &project_rows),
        ),
        (
            "mois",
            "Par mois",
            acx_table(&with_period("Mois"), &acx_period_rows(&months)),
        ),
        (
            "semaines",
            "Par semaine",
            acx_table(&with_period("Semaine"), &acx_period_rows(&weeks)),
        ),
        (
            "jours",
            days_title,
            acx_table(&with_period("Jour"), &acx_period_rows(&days)),
        ),
        (
            "sessions",
            "Les 100 dernières sessions",
            acx_table(&session_headers, &session_rows),
        ),
        ("limites", "Limites atteintes", limits_html),
        (
            "lecture",
            "Notes de lecture",
            format!(
                concat!(
                    r#"<dl class="acx-paires">"#,
                    r#"<div class="acx-paire"><dt>Output</dt><dd>Tokens produits par le modèle, réflexion comprise.</dd></div>"#,
                    r#"<div class="acx-paire"><dt>Cache écrit</dt><dd>Contexte envoyé au modèle et mis en cache pour les tours suivants.</dd></div>"#,
                    r#"<div class="acx-paire"><dt>Cache lu</dt><dd>Contexte relu depuis le cache. L'essentiel du volume brut, mais il pèse beaucoup moins dans le quota.</dd></div>"#,
                    r#"<div class="acx-paire"><dt>Output + cache écrit</dt><dd>Le repère retenu pour comparer projets et périodes.</dd></div>"#,
                    r#"</dl>"#,
                    r#"<div class="acx-encadre est-vigilance"><span class="acx-encadre-titre">Limite assumée</span>"#,
                    r#"<p>Le quota d'abonnement n'est pas un simple total de tokens : ces chiffres servent à comparer, "#,
                    r#"pas à prédire le moment où une limite sera atteinte. Une limite touchée par plusieurs sous-agents "#,
                    r#"en parallèle est comptée une seule fois.</p></div>"#,
                    r#"<p>Établi à partir des transcripts de Claude Code, conservés dans <span class="acx-mono">{db}</span>.</p>"#
                ),
                db = esc(&db)
            ),
        ),
    ];

    let summary: String = sections
        .iter()
        .map(|(a, t, _)| format!(r##"<li><a href="#{a}">{}</a></li>"##, esc(t)))
        .collect();
    let body: String = sections
        .iter()
        .map(|(a, t, c)| format!(r#"<section id="{a}"><h2>{}</h2>{c}</section>"#, esc(t)))
        .collect();

    format!(
        r##"<header class="acx-entete">
  <!--LOGO-->
  <span class="acx-entete-titre">Suivi Claude Code &middot; généré le {generated}</span>
</header>
<section class="acx-hero">
  <hr class="acx-filet-rouge">
  <h1>Consommation Claude Code</h1>
  <p class="acx-sous-titre">Suivi des tokens par projet</p>
  <p class="acx-chapeau">Consommation de tokens de Claude Code sur les projets du poste, découpée par projet,
  par période et par session, avec les limites d'usage atteintes.</p>
  <dl class="acx-meta">
    <div><dt>Période</dt><dd>{period}</dd></div>
    <div><dt>Volume</dt><dd>{weight} tokens (output + cache écrit), {calls} appels</dd></div>
    <div><dt>Projets</dt><dd>{nprojects}</dd></div>
    <div><dt>Sessions</dt><dd>{nsessions}</dd></div>
    <div><dt>Source</dt><dd>Transcripts Claude Code</dd></div>
  </dl>
</section>
<main>
  <nav class="acx-sommaire" aria-label="Sommaire">
    <h2>Sommaire</h2>
    <ol>{summary}</ol>
  </nav>
  {body}
</main>
<footer class="acx-pied">
  <div class="acx-pied-inner">
    <p><strong>Suivi de consommation Claude Code</strong> &mdash; rapport généré par SkillManager.</p>
    <p>Document de travail interne. Source : <span class="acx-mono">{db}</span>.</p>
  </div>
</footer>
<a class="acx-retour-haut" href="#" aria-label="Retour en haut de page">&uarr;</a>
"##,
        generated = now.format("%d/%m/%Y à %H:%M"),
        period = esc(&period_label(filter, data)),
        weight = fmt_tokens(total_weight),
        calls = thousands(total_calls),
        nprojects = projects.len(),
        nsessions = session_count,
        db = esc(&db),
    )
}

/// Same assembly as the skill's `assembler-cr.ps1`: charter, logo, favicon and
/// floating summary injected around a body that carries no style.
fn build_acx_html(filter: &Filter, data: &Dataset, assets: &Path) -> Result<String> {
    let body = build_acx_body(filter, data);

    let logo_src = fs::read_to_string(assets.join("logo-almaviacx.svg"))?;
    let path_re = Regex::new(r"<path\b[^>]*/>").expect("static regex");
    let traces: String = path_re.find_iter(&logo_src).map(|m| m.as_str()).collect();
    if traces.is_empty() {
        return Err(Error::Other("aucun tracé trouvé dans le logo ACX".into()));
    }
    let logo = format!(
        r#"<svg class="acx-logo" viewBox="108 130 626 334" role="img" aria-label="Almavia CX" xmlns="http://www.w3.org/2000/svg">{traces}</svg>"#
    );
    let favicon = base64::engine::general_purpose::STANDARD
        .encode(fs::read(assets.join("favicon-96x96.png"))?);
    let css = fs::read_to_string(assets.join("charte-acx.css"))?;
    let floating_js = fs::read_to_string(assets.join("sommaire-flottant.js"))?;

    let mut source = body.replace("<!--LOGO-->", &logo);
    let nav_re = Regex::new(r#"(?s)<nav class="acx-sommaire"[^>]*>.*?</nav>"#).expect("static regex");
    if let Some(nav) = nav_re.find(&source) {
        let open_re = Regex::new(r"^<nav[^>]*>").expect("static regex");
        let copy = open_re
            .replace(
                nav.as_str(),
                r#"<nav class="acx-sommaire-flottant" aria-hidden="true">"#,
            )
            .to_string();
        let end = nav.end();
        source.insert_str(end, &format!("\n{copy}"));
    }

    Ok(format!(
        r#"<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {{ color-scheme: light dark; }}
  html, body {{ margin: 0; }}
  img {{ max-width: 100%; }}
  [hidden] {{ display: none !important; }}
</style>
<title>Consommation Claude Code</title>
<link rel="icon" type="image/png" sizes="96x96" href="data:image/png;base64,{favicon}">
<style>
{css}
</style>
</head>
<body>
{source}
<script>
{floating_js}
</script>
<script>
{ACX_FILTER_SCRIPT}
</script>
</body>
</html>
"#
    ))
}

pub fn export_html(path: &str, filter: &Filter) -> Result<String> {
    let assets = acx_assets_dir()?;
    let data = token_usage::load(filter)?;
    let page = build_acx_html(filter, &data, &assets)?;
    write_atomic(Path::new(path), page.as_bytes())?;
    tracing::info!(
        "token_usage.export html ok: {path} (assets {})",
        assets.display()
    );
    Ok(path.to_string())
}

// ============================================================
// Excel
// ============================================================

const XLSX_FONT: &str = "Arial";
const XLSX_HEADER_FILL: u32 = 0x003366; // AlmaviaCX night blue, like the report headers

fn xlsx_err(e: rust_xlsxwriter::XlsxError) -> Error {
    Error::Other(format!("xlsx: {e}"))
}

/// Excel refuses control characters in cell text.
fn xlsx_text(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() || matches!(c, '\t' | '\n' | '\r'))
        .collect()
}

fn col_letter(mut col: u16) -> String {
    let mut out = Vec::new();
    col += 1;
    while col > 0 {
        let rem = (col - 1) % 26;
        out.push((b'A' + rem as u8) as char);
        col = (col - 1) / 26;
    }
    out.iter().rev().collect()
}

fn excel_datetime(d: &chrono::DateTime<Local>) -> Result<rust_xlsxwriter::ExcelDateTime> {
    use chrono::Timelike;
    use chrono::Datelike;
    rust_xlsxwriter::ExcelDateTime::from_ymd(d.year() as u16, d.month() as u8, d.day() as u8)
        .and_then(|x| x.and_hms(d.hour() as u16, d.minute() as u8, d.second()))
        .map_err(xlsx_err)
}

struct Styles {
    header: rust_xlsxwriter::Format,
    body: rust_xlsxwriter::Format,
    number: rust_xlsxwriter::Format,
    bold_number: rust_xlsxwriter::Format,
    bold: rust_xlsxwriter::Format,
    note: rust_xlsxwriter::Format,
    title: rust_xlsxwriter::Format,
    datetime: rust_xlsxwriter::Format,
    datetime_short: rust_xlsxwriter::Format,
}

impl Styles {
    fn new() -> Self {
        use rust_xlsxwriter::{Format, FormatAlign};
        let base = Format::new().set_font_name(XLSX_FONT);
        Styles {
            header: base
                .clone()
                .set_bold()
                .set_font_color(0xFFFFFF)
                .set_background_color(XLSX_HEADER_FILL)
                .set_align(FormatAlign::VerticalCenter),
            body: base.clone(),
            number: base.clone().set_num_format("#,##0"),
            bold_number: base.clone().set_bold().set_num_format("#,##0"),
            bold: base.clone().set_bold(),
            note: base.clone().set_italic().set_font_color(0x6E7579),
            title: base
                .clone()
                .set_bold()
                .set_font_size(14)
                .set_font_color(XLSX_HEADER_FILL),
            datetime: base.clone().set_num_format("dd/mm/yyyy hh:mm:ss"),
            datetime_short: base.set_num_format("dd/mm/yyyy hh:mm"),
        }
    }
}

fn setup(
    sheet: &mut rust_xlsxwriter::Worksheet,
    st: &Styles,
    headers: &[&str],
    widths: &[f64],
    header_row: u32,
) -> Result<()> {
    for (c, (h, w)) in headers.iter().zip(widths).enumerate() {
        sheet
            .write_string_with_format(header_row, c as u16, *h, &st.header)
            .map_err(xlsx_err)?;
        sheet.set_column_width(c as u16, *w).map_err(xlsx_err)?;
    }
    sheet
        .set_freeze_panes(header_row + 1, 0)
        .map_err(xlsx_err)?;
    Ok(())
}

/// Autofilter over the table and, when asked, a `SUBTOTAL(109, …)` total row
/// under the numeric columns — it follows the filter, unlike `SUM`.
fn finish(
    sheet: &mut rust_xlsxwriter::Worksheet,
    st: &Styles,
    header_row: u32,
    last_row: u32,
    last_col: u16,
    total_from: Option<u16>,
) -> Result<()> {
    if last_row <= header_row {
        return Ok(());
    }
    sheet
        .autofilter(header_row, 0, last_row, last_col)
        .map_err(xlsx_err)?;
    if let Some(from) = total_from {
        let total_row = last_row + 1;
        sheet
            .write_string_with_format(total_row, 0, "Total", &st.bold)
            .map_err(xlsx_err)?;
        for col in from..=last_col {
            let l = col_letter(col);
            // Excel rows are 1-based in formulas.
            let formula = format!("=SUBTOTAL(109,{l}{}:{l}{})", header_row + 2, last_row + 1);
            sheet
                .write_formula_with_format(total_row, col, formula.as_str(), &st.bold_number)
                .map_err(xlsx_err)?;
        }
    }
    Ok(())
}

// Column letters of the Détail sheet (the source of every summary formula).
const D_DAY: &str = "B";
const D_WEEK: &str = "C";
const D_MONTH: &str = "D";
const D_PROJECT: &str = "E";
const D_SESSION: &str = "G";
const D_INPUT: &str = "K";
const D_OUTPUT: &str = "L";
const D_CACHE_W: &str = "M";
const D_CACHE_R: &str = "N";
// And of the Limites sheet.
const L_PROJECT: &str = "E";
const L_SESSION: &str = "F";

const USAGE_HEADERS: [&str; 7] = [
    "Appels",
    "Input",
    "Output",
    "Cache écrit",
    "Cache lu",
    "Output + cache écrit",
    "Limites",
];
const USAGE_WIDTHS: [f64; 7] = [10.0, 10.0, 12.0, 13.0, 15.0, 20.0, 9.0];

/// The seven usage columns of one summary row, starting at `first_col` on row
/// `r` (0-based). `detail` / `limits` are COUNTIFS/SUMIFS criteria pairs.
fn write_usage_formulas(
    sheet: &mut rust_xlsxwriter::Worksheet,
    st: &Styles,
    r: u32,
    first_col: u16,
    detail: &str,
    limits: &str,
) -> Result<()> {
    let sum = |col: &str| format!("=SUMIFS('Détail'!${col}:${col},{detail})");
    let out_col = col_letter(first_col + 2);
    let cw_col = col_letter(first_col + 3);
    let row1 = r + 1;
    let formulas = [
        format!("=COUNTIFS({detail})"),
        sum(D_INPUT),
        sum(D_OUTPUT),
        sum(D_CACHE_W),
        sum(D_CACHE_R),
        format!("={out_col}{row1}+{cw_col}{row1}"),
        format!("=COUNTIFS({limits})"),
    ];
    for (i, f) in formulas.iter().enumerate() {
        sheet
            .write_formula_with_format(r, first_col + i as u16, f.as_str(), &st.number)
            .map_err(xlsx_err)?;
    }
    Ok(())
}

pub fn export_xlsx(path: &str, filter: &Filter) -> Result<String> {
    use rust_xlsxwriter::Workbook;

    let data = token_usage::load(filter)?;
    let st = Styles::new();
    let mut wb = Workbook::new();

    // --- Projets
    {
        let sheet = wb.add_worksheet().set_name("Projets").map_err(xlsx_err)?;
        sheet
            .write_string_with_format(0, 0, "Consommation Claude Code par projet", &st.title)
            .map_err(xlsx_err)?;
        sheet
            .write_string_with_format(
                1,
                0,
                format!(
                    "Généré le {}. Les onglets de synthèse sont calculés par formules sur les onglets Détail et Limites.",
                    Local::now().format("%d/%m/%Y à %H:%M")
                ),
                &st.note,
            )
            .map_err(xlsx_err)?;
        let header_row = 3;
        let mut headers = vec!["Projet"];
        headers.extend(USAGE_HEADERS);
        let mut widths = vec![34.0];
        widths.extend(USAGE_WIDTHS);
        setup(sheet, &st, &headers, &widths, header_row)?;
        let mut r = header_row;
        for b in aggregate(&data, By::Project) {
            r += 1;
            sheet
                .write_string_with_format(r, 0, xlsx_text(&b.label), &st.body)
                .map_err(xlsx_err)?;
            let a = format!("$A{}", r + 1);
            write_usage_formulas(
                sheet,
                &st,
                r,
                1,
                &format!("'Détail'!${D_PROJECT}:${D_PROJECT},{a}"),
                &format!("'Limites'!${L_PROJECT}:${L_PROJECT},{a}"),
            )?;
        }
        finish(sheet, &st, header_row, r, 7, Some(1))?;
        sheet
            .write_string_with_format(
                r + 3,
                0,
                "« Output + cache écrit » sert de repère pour comparer : le cache lu domine le volume brut mais pèse beaucoup moins dans le quota.",
                &st.note,
            )
            .map_err(xlsx_err)?;
    }

    // --- Mois / Semaines / Jours
    for (by, name, header, detail_col, limit_col) in [
        (By::Month, "Mois", "Mois", D_MONTH, "D"),
        (By::Week, "Semaines", "Semaine", D_WEEK, "C"),
        (By::Day, "Jours", "Jour", D_DAY, "B"),
    ] {
        let sheet = wb.add_worksheet().set_name(name).map_err(xlsx_err)?;
        let mut headers = vec![header, "Projet"];
        headers.extend(USAGE_HEADERS);
        let mut widths = vec![12.0, 34.0];
        widths.extend(USAGE_WIDTHS);
        setup(sheet, &st, &headers, &widths, 0)?;
        let mut r = 0;
        for b in aggregate(&data, by) {
            r += 1;
            sheet
                .write_string_with_format(r, 0, &b.period, &st.body)
                .map_err(xlsx_err)?;
            sheet
                .write_string_with_format(r, 1, xlsx_text(&b.label), &st.body)
                .map_err(xlsx_err)?;
            let (a, bb) = (format!("$A{}", r + 1), format!("$B{}", r + 1));
            write_usage_formulas(
                sheet,
                &st,
                r,
                2,
                &format!("'Détail'!${detail_col}:${detail_col},{a},'Détail'!${D_PROJECT}:${D_PROJECT},{bb}"),
                &format!("'Limites'!${limit_col}:${limit_col},{a},'Limites'!${L_PROJECT}:${L_PROJECT},{bb}"),
            )?;
        }
        finish(sheet, &st, 0, r, 8, Some(2))?;
    }

    // --- Sessions
    {
        let sheet = wb.add_worksheet().set_name("Sessions").map_err(xlsx_err)?;
        let mut headers = vec!["Début", "Fin", "Durée (min)", "Projet", "Session", "Première demande"];
        headers.extend(USAGE_HEADERS);
        let mut widths = vec![17.0, 17.0, 11.0, 30.0, 38.0, 60.0];
        widths.extend(USAGE_WIDTHS);
        setup(sheet, &st, &headers, &widths, 0)?;
        let mut r = 0;
        for b in aggregate(&data, By::Session) {
            r += 1;
            let row1 = r + 1;
            if let (Some(s), Some(e)) = (b.start_at, b.end_at) {
                sheet
                    .write_datetime_with_format(r, 0, excel_datetime(&s)?, &st.datetime_short)
                    .map_err(xlsx_err)?;
                sheet
                    .write_datetime_with_format(r, 1, excel_datetime(&e)?, &st.datetime_short)
                    .map_err(xlsx_err)?;
            }
            sheet
                .write_formula_with_format(
                    r,
                    2,
                    format!("=ROUND((B{row1}-A{row1})*1440,0)").as_str(),
                    &st.number,
                )
                .map_err(xlsx_err)?;
            sheet
                .write_string_with_format(r, 3, xlsx_text(&b.label), &st.body)
                .map_err(xlsx_err)?;
            sheet
                .write_string_with_format(r, 4, &b.period, &st.body)
                .map_err(xlsx_err)?;
            sheet
                .write_string_with_format(r, 5, xlsx_text(&b.title), &st.body)
                .map_err(xlsx_err)?;
            let e = format!("$E{row1}");
            write_usage_formulas(
                sheet,
                &st,
                r,
                6,
                &format!("'Détail'!${D_SESSION}:${D_SESSION},{e}"),
                &format!("'Limites'!${L_SESSION}:${L_SESSION},{e}"),
            )?;
        }
        finish(sheet, &st, 0, r, 12, Some(6))?;
    }

    // --- Limites: one row per distinct limit event.
    {
        let sheet = wb.add_worksheet().set_name("Limites").map_err(xlsx_err)?;
        setup(
            sheet,
            &st,
            &["Quand", "Jour", "Semaine", "Mois", "Projet", "Session", "Première demande", "Message"],
            &[17.0, 11.0, 10.0, 9.0, 30.0, 38.0, 50.0, 70.0],
            0,
        )?;
        let mut r = 0;
        for l in &data.limits {
            let Some(when) = l.when else { continue };
            r += 1;
            sheet
                .write_datetime_with_format(r, 0, excel_datetime(&when)?, &st.datetime_short)
                .map_err(xlsx_err)?;
            for (c, v) in [
                (1, day_key(&when)),
                (2, week_key(&when)),
                (3, month_key(&when)),
                (4, xlsx_text(&l.label)),
                (5, l.session_id.clone()),
                (6, xlsx_text(&l.title)),
                (7, xlsx_text(&l.text)),
            ] {
                sheet
                    .write_string_with_format(r, c, v, &st.body)
                    .map_err(xlsx_err)?;
            }
        }
        finish(sheet, &st, 0, r, 7, None)?;
    }

    // --- Détail: one row per API call, the source of every summary formula.
    {
        let sheet = wb.add_worksheet().set_name("Détail").map_err(xlsx_err)?;
        setup(
            sheet,
            &st,
            &[
                "Horodatage", "Jour", "Semaine", "Mois", "Projet", "Répertoire", "Session",
                "Première demande", "Modèle", "Sous-agent", "Input", "Output", "Cache écrit",
                "Cache lu",
            ],
            &[18.0, 11.0, 10.0, 9.0, 30.0, 40.0, 38.0, 50.0, 20.0, 10.0, 10.0, 10.0, 12.0, 14.0],
            0,
        )?;
        let mut r = 0;
        for row in &data.rows {
            r += 1;
            sheet
                .write_datetime_with_format(r, 0, excel_datetime(&row.when)?, &st.datetime)
                .map_err(xlsx_err)?;
            let title = data.titles.get(&row.session_id).cloned().unwrap_or_default();
            for (c, v) in [
                (1, day_key(&row.when)),
                (2, week_key(&row.when)),
                (3, month_key(&row.when)),
                (4, xlsx_text(&row.label)),
                (5, xlsx_text(&row.cwd)),
                (6, row.session_id.clone()),
                (7, xlsx_text(&title)),
                (8, row.model.clone()),
                (9, if row.sidechain { "Oui".into() } else { "Non".into() }),
            ] {
                sheet
                    .write_string_with_format(r, c, v, &st.body)
                    .map_err(xlsx_err)?;
            }
            for (c, v) in [
                (10, row.input),
                (11, row.output),
                (12, row.cache_write),
                (13, row.cache_read),
            ] {
                sheet
                    .write_number_with_format(r, c, v as f64, &st.number)
                    .map_err(xlsx_err)?;
            }
        }
        finish(sheet, &st, 0, r, 13, None)?;
    }

    let bytes = wb.save_to_buffer().map_err(xlsx_err)?;
    write_atomic(Path::new(path), &bytes)?;
    tracing::info!("token_usage.export xlsx ok: {path}");
    Ok(path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn column_letters() {
        assert_eq!(col_letter(0), "A");
        assert_eq!(col_letter(13), "N");
        assert_eq!(col_letter(26), "AA");
    }

    #[test]
    fn french_thousands() {
        assert_eq!(thousands(1_234_567), "1 234 567");
        assert_eq!(thousands(12), "12");
    }

    #[test]
    fn semver_compares_numerically() {
        assert!(semver_of("10.0.0") > semver_of("4.1.1"));
        assert!(semver_of("not-a-version").is_none());
    }
}

