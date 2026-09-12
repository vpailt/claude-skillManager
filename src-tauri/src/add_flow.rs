//! Parcours d'ajout unifié : un plugin ou un skill, venant d'un dépôt distant
//! ou d'un dossier local, posé à sa destination une fois ses métadonnées
//! complètes.
//!
//! L'ajout se fait en **deux temps**, et c'est ce qui permet de *proposer* une
//! complétion au lieu de refuser la source :
//!
//! 1. [`stage_local`] / [`stage_remote`] matérialisent la source dans un
//!    dossier de préparation sous `<exe_dir>/staging/`, puis [`inspect`] y lit
//!    les métadonnées et dit ce qui manque. Rien n'a encore bougé dans
//!    `~/.claude`, et **la source de l'utilisateur n'est jamais modifiée** —
//!    c'est la copie de préparation qu'on complète.
//! 2. [`commit`] écrit les métadonnées validées dans cette copie, la pose à sa
//!    destination et efface la préparation.
//!
//! Le dossier de préparation est balayé au démarrage ([`sweep_staging`]) : un
//! dialogue abandonné, ou une session tuée entre les deux temps, ne laisse pas
//! de copie derrière lui.

use crate::config;
use crate::error::{Error, Result};
use crate::frontmatter::{self, Fields};
use crate::github_client::GitHubClient;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Ce que l'on ajoute. Le parcours est le même des deux côtés ; ce qui change
/// est le fichier de métadonnées (`SKILL.md` ou `manifest.json`) et la
/// destination.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AddKind {
    Skill,
    Plugin,
}

/// Un champ de métadonnée présenté à l'utilisateur, pré-rempli avec ce que la
/// source porte déjà. `required` vide bloque l'ajout ; le reste n'est qu'une
/// suggestion (cf. Q1/Q2 : `version` d'un skill est proposée, jamais exigée).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaField {
    pub key: String,
    pub label: String,
    pub value: String,
    pub required: bool,
    pub multiline: bool,
}

impl MetaField {
    fn new(key: &str, label: &str, value: String, required: bool, multiline: bool) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            value,
            required,
            multiline,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddInspection {
    pub kind: AddKind,
    /// Dossier de préparation — à repasser tel quel à [`commit`].
    pub staging_dir: String,
    /// Nom proposé pour le dossier de destination.
    pub suggested_name: String,
    /// D'où vient cette source, en clair (chemin local ou `owner/repo@ref`).
    pub source_label: String,
    pub fields: Vec<MetaField>,
    /// Ce qui manque, en français. Vide = rien à compléter.
    pub problems: Vec<String>,
    pub file_count: usize,
}

/// La destination d'un ajout.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AddTarget {
    /// `~/.claude/skills/<slug>/` — un skill qui n'appartient à aucun plugin.
    UserSkills,
    /// `<plugin>/skills/<slug>/` — un skill dans un plugin installé.
    // `rename_all` sur l'enum ne renomme que les variantes : sans ce second
    // attribut, `installPath` arriverait du frontend sous un nom que serde ne
    // reconnaît pas.
    #[serde(rename_all = "camelCase")]
    Plugin {
        marketplace: String,
        plugin: String,
        install_path: String,
    },
    /// `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`.
    ///
    /// Un plugin a toujours une marketplace d'appartenance : le cache est rangé
    /// par marketplace, et c'est aussi ce qui rend le plugin chargeable par
    /// Claude Code, qui ne connaît rien d'autre.
    Marketplace { marketplace: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddOutcome {
    /// Ce qui a été écrit sur le disque.
    pub path: String,
    pub name: String,
    pub marketplace: String,
    pub plugin: String,
}

/// Ce qu'une URL de dépôt désigne : le dépôt, la référence, et le sous-dossier
/// quand l'URL en pointe un.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    pub repo: String,
    pub r#ref: String,
    pub subpath: String,
}

/// Lit `owner/repo`, la référence et le sous-dossier d'une URL de navigation —
/// `…/tree/<ref>/<chemin>` (GitHub) ou `…/src/branch/<ref>/<chemin>` (Gitea).
///
/// C'est ce qui permet de coller l'URL d'**un** skill dans un dépôt qui en
/// contient plusieurs, au lieu de se voir refuser la source. Une référence
/// contenant un `/` (`feature/x`) n'est pas distinguable du chemin qui la suit :
/// on prend le premier segment, comme le fait la barre d'adresse de la forge.
/// La référence vide est résolue plus tard par la branche par défaut du dépôt.
pub fn parse_source_url(url: &str) -> Option<SourceRef> {
    let repo = crate::registry::parse_github_marketplace_url(url)?;
    let path = url
        .trim()
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .to_string();
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    // Retrouver `repo` dans les segments : ce qui suit son nom est la partie
    // navigation.
    let repo_leaf = repo.rsplit('/').next().unwrap_or_default();
    let after: Vec<&str> = match segs.iter().rposition(|s| s.trim_end_matches(".git") == repo_leaf)
    {
        Some(i) => segs[i + 1..].to_vec(),
        None => Vec::new(),
    };
    let (r#ref, rest): (String, &[&str]) = match after.first().copied() {
        Some("tree") | Some("blob") if after.len() >= 2 => (after[1].into(), &after[2..]),
        Some("src") | Some("raw") if after.len() >= 3 => (after[2].into(), &after[3..]),
        _ => (String::new(), &[]),
    };
    Some(SourceRef {
        repo,
        r#ref,
        subpath: rest.join("/"),
    })
}

// ============================================================
// Dossier de préparation
// ============================================================

/// Efface tout ce que `<exe_dir>/staging/` contient. Appelé au démarrage : une
/// préparation n'a de sens que dans la session qui l'a créée.
pub fn sweep_staging() {
    let root = config::staging_dir();
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let removed = if path.is_dir() {
            crate::installer::rmtree_robust(&path).is_ok()
        } else {
            fs::remove_file(&path).is_ok()
        };
        if removed {
            tracing::debug!("sweep_staging: removed {}", path.display());
        }
    }
}

fn new_staging_dir() -> Result<PathBuf> {
    let root = config::staging_dir();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    for n in 0..64 {
        let dir = root.join(format!("add-{stamp}-{n}"));
        if !dir.exists() {
            fs::create_dir_all(&dir)?;
            return Ok(dir);
        }
    }
    Err(Error::Other(
        "Impossible de créer un dossier de préparation.".into(),
    ))
}

/// Le chemin rendu par [`AddInspection`] revient du frontend : il ne sert de
/// source à une copie qu'après avoir été confirmé sous `staging/`. Sans cette
/// garde, `commit` copierait n'importe quel dossier de la machine — et
/// `discard` en effacerait n'importe lequel.
fn staging_root_of(dir: &Path) -> Result<PathBuf> {
    let root = config::staging_dir();
    let root = fs::canonicalize(&root).unwrap_or(root);
    let dir = fs::canonicalize(dir).map_err(|_| {
        Error::Invalid("Ce dossier de préparation n'existe plus — relancez l'ajout.".into())
    })?;
    let rel = dir
        .strip_prefix(&root)
        .map_err(|_| Error::Invalid("Dossier de préparation invalide.".into()))?;
    let first = rel
        .components()
        .next()
        .ok_or_else(|| Error::Invalid("Dossier de préparation invalide.".into()))?;
    Ok(root.join(first.as_os_str()))
}

/// Abandonne une préparation (dialogue fermé, source remplacée par une autre).
pub fn discard(staging_dir: &str) {
    let path = PathBuf::from(staging_dir);
    if let Ok(root) = staging_root_of(&path) {
        let _ = crate::installer::rmtree_robust(&root);
    }
}

// ============================================================
// Étape 1 — matérialiser et inspecter
// ============================================================

/// Copie un dossier local dans la préparation, puis l'inspecte. Le dossier
/// d'origine n'est ni lu ni écrit ensuite : tout se joue sur la copie.
pub fn stage_local(kind: AddKind, source: &Path) -> Result<AddInspection> {
    if !source.is_dir() {
        return Err(Error::NotFound(format!(
            "Dossier introuvable : {}",
            source.display()
        )));
    }
    let dir = new_staging_dir()?;
    let content = dir.join("content");
    crate::local_scanner::copy_skill_tree(source, &content)?;
    inspect(kind, &content, &source.to_string_lossy())
}

/// Fabrique une ébauche dans la préparation : un `SKILL.md` (nom + corps
/// optionnel) ou un squelette de plugin (`manifest.json` + `skills/`). C'est la
/// troisième provenance, celle qui n'en est pas une — elle emprunte le même
/// chemin que les deux autres, donc la complétion des métadonnées et le choix
/// de la destination sont les mêmes.
pub fn stage_blank(kind: AddKind, name: &str, body: &str) -> Result<AddInspection> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::Invalid("Le nom est requis.".into()));
    }
    let slug = crate::admin::safe_slug(name);
    if slug.is_empty() {
        return Err(Error::Invalid(format!("Nom invalide : {name:?}")));
    }
    let dir = new_staging_dir()?;
    let content = dir.join("content").join(&slug);
    fs::create_dir_all(&content)?;
    match kind {
        AddKind::Skill => {
            fs::write(
                content.join("SKILL.md"),
                crate::admin::build_skill_md(name, "", body),
            )?;
        }
        AddKind::Plugin => {
            fs::create_dir_all(content.join("skills"))?;
            crate::installer::atomic_write_json(
                &content.join("manifest.json"),
                &serde_json::json!({ "name": name, "version": "0.1.0", "description": "" }),
            )?;
        }
    }
    inspect(kind, &content, "nouveau (vierge)")
}

/// Télécharge le zipball d'un dépôt (au sous-chemin donné), l'extrait dans la
/// préparation, puis l'inspecte. Pas de `git` : c'est l'archive de l'API REST,
/// comme pour toute installation.
pub fn stage_remote(
    kind: AddKind,
    gh: &GitHubClient,
    repo: &str,
    r#ref: &str,
    subpath: &str,
) -> Result<AddInspection> {
    let zip = gh.download_zipball(repo, r#ref)?;
    let dir = new_staging_dir()?;
    let content = dir.join("content");
    fs::create_dir_all(&content)?;
    GitHubClient::extract_zipball(&zip, &content, subpath)?;
    let label = if subpath.is_empty() {
        format!("{repo}@{}", r#ref)
    } else {
        format!("{repo}@{}/{subpath}", r#ref)
    };
    inspect(kind, &content, &label)
}

fn inspect(kind: AddKind, content: &Path, source_label: &str) -> Result<AddInspection> {
    let root = match kind {
        AddKind::Skill => find_skill_root(content)?,
        AddKind::Plugin => find_plugin_root(content),
    };
    let folder_name = root
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let (fields, problems) = match kind {
        AddKind::Skill => skill_fields(&root, &folder_name),
        AddKind::Plugin => plugin_fields(&root, &folder_name),
    };
    let suggested_name = fields
        .iter()
        .find(|f| f.key == "name")
        .map(|f| f.value.clone())
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(folder_name);
    let file_count = walkdir::WalkDir::new(&root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .count();
    Ok(AddInspection {
        kind,
        staging_dir: root.to_string_lossy().into(),
        suggested_name,
        source_label: source_label.to_string(),
        fields,
        problems,
        file_count,
    })
}

fn skill_md_in(dir: &Path) -> Option<PathBuf> {
    for name in ["SKILL.md", "skill.md"] {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn manifest_in(dir: &Path) -> Option<PathBuf> {
    for rel in ["manifest.json", ".claude-plugin/plugin.json"] {
        let p = dir.join(rel);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Le dossier du skill dans la préparation. Un dépôt dont la racine porte un
/// `SKILL.md` est le skill lui-même ; sinon on cherche, et **on ne devine pas
/// quand il y en a plusieurs** : coller l'URL d'un dépôt de skills ne doit pas
/// en importer un au hasard.
fn find_skill_root(content: &Path) -> Result<PathBuf> {
    if skill_md_in(content).is_some() {
        return Ok(content.to_path_buf());
    }
    let mut found: Vec<PathBuf> = walkdir::WalkDir::new(content)
        .max_depth(3)
        .sort_by_file_name()
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_dir() && skill_md_in(e.path()).is_some())
        .map(|e| e.into_path())
        .collect();
    match found.len() {
        0 => Err(Error::Invalid(
            "Aucun SKILL.md dans cette source — ce n'est pas un skill.".into(),
        )),
        1 => Ok(found.remove(0)),
        n => {
            let list: Vec<String> = found
                .iter()
                .take(8)
                .map(|p| {
                    p.strip_prefix(content)
                        .unwrap_or(p)
                        .to_string_lossy()
                        .replace('\\', "/")
                })
                .collect();
            Err(Error::Invalid(format!(
                "Cette source contient {n} skills. Désignez-en un seul \
                 (dossier précis, ou URL pointant le sous-dossier) : {}{}",
                list.join(", "),
                if n > 8 { "…" } else { "" }
            )))
        }
    }
}

/// Le dossier du plugin. Sans manifeste on garde la racine : l'absence est un
/// problème à compléter, pas une raison de refuser la source.
fn find_plugin_root(content: &Path) -> PathBuf {
    if manifest_in(content).is_some() {
        return content.to_path_buf();
    }
    walkdir::WalkDir::new(content)
        .max_depth(2)
        .sort_by_file_name()
        .into_iter()
        .filter_map(|e| e.ok())
        .find(|e| e.file_type().is_dir() && manifest_in(e.path()).is_some())
        .map(|e| e.into_path())
        .unwrap_or_else(|| content.to_path_buf())
}

/// Q1 : `name` et `description` bloquants — ce que Claude Code lit vraiment —
/// et `version` proposée, jamais exigée. `skill_version` la lit déjà en
/// `version` ou `metadata.version` ; on écrit toujours la première forme.
fn skill_fields(root: &Path, folder_name: &str) -> (Vec<MetaField>, Vec<String>) {
    let text = skill_md_in(root)
        .and_then(|p| fs::read_to_string(p).ok())
        .unwrap_or_default();
    let (fm, _) = frontmatter::parse_frontmatter(&text);
    let get = |k: &str| fm.get(k).cloned().unwrap_or_default().trim().to_string();

    let name = if get("name").is_empty() {
        folder_name.to_string()
    } else {
        get("name")
    };
    let description = get("description");
    let version = if get("version").is_empty() {
        fm.get("metadata.version").cloned().unwrap_or_default()
    } else {
        get("version")
    };

    let mut problems = Vec::new();
    if description.is_empty() {
        problems.push(
            "Le SKILL.md n'a pas de `description` — c'est elle qui dit à Claude quand \
             déclencher le skill."
                .into(),
        );
    }
    if fm.get("name").map(|v| v.trim().is_empty()).unwrap_or(true) {
        problems.push(format!(
            "Le SKILL.md n'a pas de `name` — proposé : « {name} »."
        ));
    }
    (
        vec![
            MetaField::new("name", "Nom", name, true, false),
            MetaField::new("description", "Description", description, true, true),
            MetaField::new(
                "version",
                "Version (facultative)",
                if version.trim().is_empty() {
                    "0.1.0".into()
                } else {
                    version
                },
                false,
                false,
            ),
        ],
        problems,
    )
}

/// Q2 : `name`, `version` et `description` bloquants. Les deux premiers le sont
/// déjà de fait — `prepare_add_plugin` échoue durement sur un manifeste sans
/// version, et c'est exactement ce que cette étape sert à détecter avant.
fn plugin_fields(root: &Path, folder_name: &str) -> (Vec<MetaField>, Vec<String>) {
    let manifest = manifest_in(root);
    let obj: Map<String, Value> = manifest
        .as_ref()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let get = |k: &str| {
        obj.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_string()
    };

    let name = if get("name").is_empty() {
        folder_name.to_string()
    } else {
        get("name")
    };
    let version = get("version");
    let description = get("description");

    let mut problems = Vec::new();
    if manifest.is_none() {
        // Inutile d'énumérer les trois champs derrière : sans fichier, ils
        // manquent tous, et les champs du dialogue le disent déjà.
        problems.push(
            "Cette source n'a pas de `manifest.json` — il sera créé avec les champs \
             ci-dessous."
                .into(),
        );
    } else {
        // Même règle qu'à la publication, appliquée ici en premier : c'est tout
        // l'intérêt de l'étape, proposer la complétion plutôt que laisser
        // `prepare_add_plugin` échouer une fois le plugin déjà installé.
        problems.extend(crate::admin::validate_plugin_manifest(&obj));
    }
    (
        vec![
            MetaField::new("name", "Nom", name, true, false),
            MetaField::new(
                "version",
                "Version",
                if version.is_empty() {
                    "0.1.0".into()
                } else {
                    version
                },
                true,
                false,
            ),
            MetaField::new("description", "Description", description, true, true),
        ],
        problems,
    )
}

// ============================================================
// Étape 2 — écrire les métadonnées et poser à destination
// ============================================================

/// Les champs sans lesquels l'ajout est refusé, côté backend comme côté
/// dialogue : Q1 pour un skill (`version` reste une suggestion), Q2 pour un
/// plugin.
pub fn required_keys(kind: AddKind) -> &'static [&'static str] {
    match kind {
        AddKind::Skill => &["name", "description"],
        AddKind::Plugin => &["name", "version", "description"],
    }
}

/// Écrit les métadonnées complétées dans la préparation, pose le résultat à sa
/// destination, puis efface la préparation.
pub fn commit(
    kind: AddKind,
    staging_dir: &str,
    fields: &Fields,
    target: &AddTarget,
) -> Result<AddOutcome> {
    let dir = PathBuf::from(staging_dir);
    let root = staging_root_of(&dir)?;
    let dir = fs::canonicalize(&dir).unwrap_or(dir);

    let missing: Vec<&str> = required_keys(kind)
        .iter()
        .filter(|k| {
            fields
                .get(**k)
                .map(|v| v.trim().is_empty())
                .unwrap_or(true)
        })
        .copied()
        .collect();
    if !missing.is_empty() {
        return Err(Error::Invalid(format!(
            "Métadonnées incomplètes : {} manque(nt).",
            missing.join(", ")
        )));
    }
    let name = fields["name"].trim().to_string();

    match kind {
        AddKind::Skill => write_skill_metadata(&dir, fields)?,
        AddKind::Plugin => write_plugin_metadata(&dir, fields)?,
    }

    let outcome = match (kind, target) {
        (AddKind::Skill, AddTarget::UserSkills) => {
            let slug = crate::admin::safe_slug(&name);
            if slug.is_empty() {
                return Err(Error::Invalid(format!("Nom de skill invalide : {name:?}")));
            }
            let dest = config::claude_user_skills_dir().join(&slug);
            if dest.exists() {
                return Err(Error::Invalid(format!(
                    "Un skill nommé « {slug} » existe déjà dans ~/.claude/skills/."
                )));
            }
            crate::local_scanner::copy_skill_tree(&dir, &dest)?;
            tracing::info!("add_flow: skill « {} » ajouté dans {}", name, dest.display());
            AddOutcome {
                path: dest.to_string_lossy().into(),
                name,
                marketplace: String::new(),
                plugin: String::new(),
            }
        }
        (
            AddKind::Skill,
            AddTarget::Plugin {
                marketplace,
                plugin,
                install_path,
            },
        ) => {
            let dest = crate::local_scanner::create_skill_in_plugin(
                Path::new(install_path),
                &name,
                dir,
            )?;
            tracing::info!(
                "add_flow: skill « {}» ajouté au plugin {}@{} ({})",
                name,
                plugin,
                marketplace,
                dest.display()
            );
            AddOutcome {
                path: dest.to_string_lossy().into(),
                name,
                marketplace: marketplace.clone(),
                plugin: plugin.clone(),
            }
        }
        (AddKind::Plugin, AddTarget::Marketplace { marketplace }) => {
            let version = fields
                .get("version")
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| Error::Invalid("La version du plugin est requise.".into()))?;
            let dest = crate::installer::install_plugin_from_directory(
                &dir,
                marketplace,
                &name,
                version,
            )?;
            tracing::info!(
                "add_flow: plugin « {} » v{} ajouté à la marketplace {} ({})",
                name,
                version,
                marketplace,
                dest.display()
            );
            AddOutcome {
                path: dest.to_string_lossy().into(),
                name: name.clone(),
                marketplace: marketplace.clone(),
                plugin: name,
            }
        }
        (kind, _) => {
            return Err(Error::Invalid(format!(
                "Destination incompatible avec un ajout de type {kind:?}."
            )))
        }
    };

    let _ = crate::installer::rmtree_robust(&root);
    Ok(outcome)
}

fn write_skill_metadata(root: &Path, fields: &Fields) -> Result<()> {
    let path = skill_md_in(root).unwrap_or_else(|| root.join("SKILL.md"));
    let text = fs::read_to_string(&path).unwrap_or_default();
    let mut updates = Fields::new();
    for key in ["name", "description", "version"] {
        if let Some(v) = fields.get(key) {
            if !v.trim().is_empty() {
                updates.insert(key.to_string(), v.trim().to_string());
            }
        }
    }
    fs::write(&path, frontmatter::set_fields(&text, &updates))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_url_plain_repo() {
        let s = parse_source_url("https://github.com/owner/repo").unwrap();
        assert_eq!(s.repo, "owner/repo");
        assert!(s.r#ref.is_empty());
        assert!(s.subpath.is_empty());
    }

    #[test]
    fn source_url_github_tree_subpath() {
        let s =
            parse_source_url("https://github.com/owner/repo/tree/main/skills/mon-skill").unwrap();
        assert_eq!(s.repo, "owner/repo");
        assert_eq!(s.r#ref, "main");
        assert_eq!(s.subpath, "skills/mon-skill");
    }

    #[test]
    fn source_url_gitea_src_branch() {
        let s = parse_source_url(
            "https://git.example.com/Claude/acx-cl/src/branch/develop/skills/a-skill",
        )
        .unwrap();
        assert_eq!(s.repo, "Claude/acx-cl");
        assert_eq!(s.r#ref, "develop");
        assert_eq!(s.subpath, "skills/a-skill");
    }

    #[test]
    fn source_url_rejects_hostless_garbage() {
        assert!(parse_source_url("pas-une-url").is_none());
    }

    #[test]
    fn skill_fields_flag_missing_description() {
        let dir = std::env::temp_dir().join(format!(
            "skillmanager-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), "---\nname: foo\n---\ncorps\n").unwrap();
        let (fields, problems) = skill_fields(&dir, "mon-dossier");
        assert_eq!(fields[0].value, "foo");
        // La version est proposée, jamais exigée (Q1).
        assert_eq!(fields[2].key, "version");
        assert!(!fields[2].required);
        assert_eq!(fields[2].value, "0.1.0");
        assert_eq!(problems.len(), 1, "{problems:?}");
        let _ = fs::remove_dir_all(&dir);
    }
}

fn write_plugin_metadata(root: &Path, fields: &Fields) -> Result<()> {
    let path = manifest_in(root).unwrap_or_else(|| root.join("manifest.json"));
    let mut obj: Map<String, Value> = fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    for key in ["name", "version", "description"] {
        if let Some(v) = fields.get(key) {
            if !v.trim().is_empty() {
                obj.insert(key.to_string(), Value::String(v.trim().to_string()));
            }
        }
    }
    crate::installer::atomic_write_json(&path, &Value::Object(obj))
}
