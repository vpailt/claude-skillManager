# Signer SkillManager (Certum Open Source Code Signing + SimplySign)

But : que Windows affiche **Open Source Developer Valentin Pitel** au lieu de
« Éditeur inconnu », sur n'importe quel poste — pas seulement ceux du domaine
AlmaviaCX. Et, depuis la v2.5, que la mise à jour automatique refuse tout binaire
qui ne porte pas cette signature.

> Ce document remplace la procédure précédente, basée sur la CA interne AlmaviaCX
> (AD CS). Elle reste techniquement valable mais n'a plus d'intérêt : sa portée
> s'arrêtait aux machines qui font confiance à la racine interne.

---

## Le certificat

| | |
|---|---|
| Produit | Certum *Open Source Code Signing in the cloud*, 365 jours |
| Sujet (CN) | `Open Source Developer Valentin Pitel` |
| Émetteur | `Certum Code Signing 2021 CA` → `Certum Trusted Network CA` (racine déjà de confiance dans Windows) |
| Empreinte SHA-1 | `386E7BA205FBE9EC379DB12E8FF24505E6719FF6` |
| Expiration | 20/08/2027 |
| Clé privée | HSM cloud Certum — **elle ne sort jamais**, obligation de stockage matériel depuis juin 2023 |

Les fichiers `.pem` / `.der` téléchargeables depuis l'espace Certum ne contiennent
que la partie publique : ils ne servent pas à signer.

---

## Prérequis à chaque build signé

1. **SimplySign Mobile** (iOS/Android) — génère les codes OTP.
2. **SimplySign Desktop** (Windows) — émule un lecteur de carte et une carte
   cryptographique. Sans session ouverte, la clé est inaccessible et le build
   échoue.

Ouvrir une session avant de builder, puis vérifier que le certificat est visible :

```pwsh
Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
  Select-Object Subject, Thumbprint, NotAfter
```

Rien ne s'affiche → la session n'est pas ouverte. C'est la cause n°1 d'un build
qui refuse de signer.

---

## Signer : c'est déjà câblé

`src-tauri/tauri.conf.json`, section `bundle.windows` :

```json
"certificateThumbprint": "386E7BA205FBE9EC379DB12E8FF24505E6719FF6",
"digestAlgorithm": "sha256",
"timestampUrl": "http://time.certum.pl"
```

Un `.\build.ps1 -Package` produit donc trois artefacts signés :

| Artefact | Signé par |
|---|---|
| `target\release\skillmanager.exe` | l'étape `-Package` de `build.ps1` (voir le piège ci-dessous) |
| `target\release\bundle\nsis\SkillManager_<v>_x64-setup.exe` | `tauri build` |
| `SkillManager_<v>_x64_portable.zip` | contient l'exe signé ci-dessus |

### Le piège : Tauri restaure le binaire non signé

`tauri build` signe bien `skillmanager.exe` — le log l'affiche — puis **restaure la
version d'avant patch une fois le bundling terminé**. La copie signée ne survit
donc qu'à l'intérieur de l'installeur NSIS ; celle qui reste sur le disque n'a plus
aucune signature. Constaté en vrai : `signtool verify` répondait *No signature
found* sur un exe que le build venait d'annoncer comme signé.

Comme le zip portable est précisément ce que la mise à jour en place télécharge,
`build.ps1 -Package` **re-signe l'exe explicitement** avant de le zipper, en
relisant l'empreinte et l'horodateur depuis `tauri.conf.json`. Ne pas supprimer ce
bloc en croyant qu'il fait doublon.

### L'horodatage n'est pas cosmétique

Sans horodatage RFC 3161, toutes les signatures deviennent invalides à l'expiration
du certificat, en août 2027 — y compris sur les binaires déjà distribués. Avec, une
signature reste valable indéfiniment : l'horodateur atteste que la signature a été
apposée pendant la période de validité.

---

## Vérifier

```pwsh
Get-AuthenticodeSignature .\src-tauri\target\release\skillmanager.exe |
  Format-List Status, SignerCertificate, TimeStamperCertificate
```
`Status : Valid` **et** un `TimeStamperCertificate` non vide = signé et horodaté.

Chaîne complète, avec le détail des autorités :
```pwsh
& "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe" verify /pa /v <fichier>
```

Pour contrôler ce que reçoivent réellement les utilisateurs, vérifier l'exe **extrait
du zip téléchargé depuis GitHub**, pas seulement celui du dossier de build.

---

## Le garde-fou côté mise à jour

`src-tauri/src/authenticode.rs` interroge `WinVerifyTrust` avant que la mise à jour
n'échange le binaire, et compare le CN du signataire à `EXPECTED_SIGNER`. Un binaire
non signé, altéré, ou signé par quelqu'un d'autre est supprimé et l'échange n'a pas
lieu ; l'utilisateur se voit alors proposer une mise à jour manuelle.

Vérifier la chaîne ne suffirait pas : n'importe quel certificat de signature de code
reconnu par Windows la satisferait, et ça s'achète. C'est l'identité du signataire
qui porte la garantie.

**Au renouvellement du certificat**, en août 2027, deux valeurs à mettre à jour
ensemble :

| Fichier | Valeur |
|---|---|
| `src-tauri/tauri.conf.json` | `certificateThumbprint` — change à chaque émission |
| `src-tauri/src/authenticode.rs` | `EXPECTED_SIGNER` — ne change que si le sujet change |

Si le sujet change et que `EXPECTED_SIGNER` est oublié, les mises à jour automatiques
s'arrêtent proprement (le bandeau propose la mise à jour manuelle) plutôt que
d'accepter un binaire inattendu. C'est le bon sens de l'échec.

---

## Ce que la signature ne fait pas

L'alerte UAC « Éditeur inconnu » disparaît dès la première signature. **SmartScreen**,
lui, peut continuer à avertir quelque temps sur les exécutables fraîchement
téléchargés : sa réputation se construit au fil des téléchargements, et seul un
certificat EV donne une réputation immédiate.

SmartScreen ne se déclenche que sur les fichiers marqués « venus d'Internet ». Pour
le vérifier sur une copie distribuée :
```pwsh
Get-Item .\skillmanager.exe -Stream Zone.Identifier -ErrorAction SilentlyContinue
```
Aucune sortie → pas de *Mark-of-the-Web* → SmartScreen ne dira rien.

---

## Aide-mémoire

| Besoin | Commande |
|---|---|
| Le certificat est-il accessible ? | `Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert` |
| Build signé + assets de release | `.\build.ps1 -Package` |
| Vérifier un fichier | `Get-AuthenticodeSignature <f> \| Format-List Status, TimeStamperCertificate` |
| Vérifier la chaîne | `signtool verify /pa /v <f>` |
| Signer un fichier à la main | `signtool sign /sha1 <empreinte> /fd sha256 /td sha256 /tr http://time.certum.pl <f>` |
