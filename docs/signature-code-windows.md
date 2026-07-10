# Signer SkillManager avec la CA interne AlmaviaCX (AD CS)

But : signer `skillmanager.exe` et son installeur NSIS pour supprimer l'alerte
Windows « Éditeur inconnu » (UAC) sur les postes du domaine AlmaviaCX.

> Portée : cette signature n'est reconnue **que** sur les machines qui font
> confiance à la racine AlmaviaCX (postes du domaine). Sur un poste hors domaine,
> l'alerte reviendra — c'est là que **Azure Trusted Signing** prendrait le relais.

---

## Ce que provoque l'alerte aujourd'hui

L'`.exe` / l'installeur NSIS ne sont pas signés, donc Windows affiche :

1. **SmartScreen** — écran bleu « Windows a protégé votre ordinateur / Éditeur inconnu ».
2. **UAC** — bandeau jaune « Éditeur inconnu » à l'élévation de droits.

Signer avec un certificat **de confiance** supprime le #2. Le #1 (SmartScreen) ne se
déclenche en pratique que sur les fichiers marqués « venus d'Internet »
(*Mark-of-the-Web*) — un exe copié depuis un partage réseau interne n'a souvent pas
cette marque, donc SmartScreen ne bronche pas (voir la vérif plus bas).

---

## Qui fait quoi

| Étape | Toi | IT AlmaviaCX |
|---|:---:|:---:|
| Publier le modèle *Code Signing* + accorder le droit d'enrôlement | | ✅ |
| Obtenir le certificat | ✅ | |
| Signer l'exe / l'installeur | ✅ | |
| Faire confiance à la racine sur les autres postes | | ✅ (souvent déjà auto) |

---

## Étape 0 — Vérifier que le terrain est favorable

**1. Poste sur le domaine ?**
```pwsh
(Get-CimInstance Win32_ComputerSystem) | Select-Object Domain, PartOfDomain
dsregcmd /status | Select-String "DomainJoined|AzureAdJoined"
```
`PartOfDomain : True` → OK.

**2. Une CA d'entreprise (AD CS) est-elle déclarée dans l'AD ?**
```pwsh
$conf = ([ADSI]"LDAP://RootDSE").Get("configurationNamingContext")
([ADSI]"LDAP://CN=Enrollment Services,CN=Public Key Services,CN=Services,$conf").Children |
  ForEach-Object { "{0}   (serveur : {1})" -f $_.cn, $_.dNSHostName }
```
Si une ou plusieurs CA sont listées → l'infra existe.

**3. La racine interne est-elle déjà de confiance sur ton poste ?**
```pwsh
Get-ChildItem Cert:\LocalMachine\Root, Cert:\LocalMachine\CA |
  Where-Object Subject -match "almavia" |
  Select-Object Subject, NotAfter, Thumbprint
```
Si la racine interne est présente → un exe signé par cette CA montrera « AlmaviaCX »
au lieu de « Éditeur inconnu ».

Si ces trois passent, tu es sur du terrain favorable.

---

## Étape 1 — Obtenir le certificat de signature de code

**Cas A — le modèle est publié et tu as le droit d'enrôlement (libre-service)**

1. `certmgr.msc` → **Personnel → Certificats** → clic droit →
   *Toutes les tâches → Demander un nouveau certificat*.
2. *Suivant* → **Stratégie d'inscription Active Directory** → *Suivant*.
3. Coche **« Signature de code »** (Code Signing) → **Inscription**.
4. Le certificat (avec sa clé privée) atterrit dans `Cert:\CurrentUser\My`.

**Cas B — le modèle n'apparaît pas**

À demander à l'IT :
> Publier le modèle *Code Signing* sur la CA d'entreprise et m'accorder les droits
> **Lecture + Inscription** sur ce modèle pour mon compte.

Alternative : l'IT t'émet le cert et te livre un `.pfx`, que tu importes avec
`Import-PfxCertificate -FilePath cert.pfx -CertStoreLocation Cert:\CurrentUser\My`.

---

## Étape 2 — Récupérer le thumbprint

```pwsh
Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
  Select-Object Subject, Thumbprint, NotAfter
```
Note le `Thumbprint` (hex majuscule, sans espaces) — clé pour la suite.

---

## Étape 3 — Signer

### Option recommandée — natif Tauri

Signe le `.exe` **et** l'installeur NSIS en un seul build. Dans
`src-tauri/tauri.conf.json`, section `bundle.windows` :

```json
"windows": {
  "webviewInstallMode": { "type": "embedBootstrapper" },
  "certificateThumbprint": "TON_THUMBPRINT_SANS_ESPACES",
  "digestAlgorithm": "sha256",
  "timestampUrl": "http://timestamp.digicert.com"
}
```

Puis `.\build.ps1` signe automatiquement.

> ⚠️ Exige `signtool` (Windows SDK) accessible — vérifie avec `Get-Command signtool`.
> Comme `build.ps1` charge déjà l'environnement VS2022, il est souvent sur le PATH.

### Option de repli — PowerShell pur (si `signtool` absent)

À ajouter en fin de `build.ps1` :

```pwsh
$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Select-Object -First 1
Set-AuthenticodeSignature -FilePath ".\src-tauri\target\release\skillmanager.exe" `
  -Certificate $cert -HashAlgorithm SHA256 `
  -TimestampServer "http://timestamp.digicert.com"
```

Inconvénient : il faut aussi signer l'installeur NSIS produit
(`...\target\release\bundle\nsis\*.exe`) avec la même commande.

> **Horodatage** : le serveur (DigiCert) est **public** et indépendant de la CA interne ;
> il faut juste un accès Internet au moment du build. Sans lui, la signature devient
> invalide à l'expiration du certificat.

---

## Étape 4 — Confiance sur les autres postes

C'est ce qui fait disparaître « éditeur inconnu » **partout**, pas juste chez toi.

Une **CA d'entreprise (Enterprise AD CS)** publie automatiquement sa racine dans le
magasin *Autorités racines de confiance* de **tous** les postes du domaine (via l'AD).
Donc si l'étape 0.3 a trouvé la racine déjà présente, il n'y a rien de plus à faire :
tout poste du domaine affichera « AlmaviaCX ».

En cas de doute, demander à l'IT de confirmer que la racine est bien distribuée par GPO.

---

## Étape 5 — Vérifier le résultat

```pwsh
Get-AuthenticodeSignature ".\src-tauri\target\release\skillmanager.exe" |
  Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
```
`Status : Valid` + un `TimeStamperCertificate` non vide = signé et horodaté.

Puis lance l'installeur en élévation : l'UAC doit afficher l'éditeur au lieu de
« Éditeur inconnu ».

**Vérif SmartScreen (Mark-of-the-Web)** — sur une copie « distribuée » :
```pwsh
Get-Item .\skillmanager.exe -Stream Zone.Identifier -ErrorAction SilentlyContinue
```
Si ça ne renvoie **rien** → pas de Mark-of-the-Web → SmartScreen ne se déclenchera pas.

---

## Prouver le mécanisme sans l'IT (dry-run auto-signé)

Pour valider toute la chaîne (signer → faire confiance → l'UAC affiche l'éditeur)
avant même d'avoir le vrai certificat interne :

```pwsh
# 1. Créer un cert code-signing bidon
$cert = New-SelfSignedCertificate -Type CodeSigningCert `
          -Subject "CN=Valentin Pitel (test)" -CertStoreLocation Cert:\CurrentUser\My

# 2. Signer une COPIE de l'exe (pas l'original)
Copy-Item .\src-tauri\target\release\skillmanager.exe .\test.exe
Set-AuthenticodeSignature -FilePath .\test.exe -Certificate $cert -HashAlgorithm SHA256

# 3. À ce stade, test.exe en élévation → UAC dit encore "Éditeur inconnu"

# 4. Rendre le cert de confiance (admin) — SUR TON POSTE DE TEST UNIQUEMENT
Export-Certificate -Cert $cert -FilePath $env:TEMP\test.cer
Import-Certificate -FilePath $env:TEMP\test.cer -CertStoreLocation Cert:\LocalMachine\Root

# 5. Relancer test.exe → UAC affiche "Valentin Pitel (test)" ✓
```

**⚠️ Nettoyage obligatoire** — ne pas laisser une racine auto-signée de confiance :
```pwsh
Get-ChildItem Cert:\LocalMachine\Root | Where-Object Subject -match "Valentin Pitel \(test\)" | Remove-Item
Get-ChildItem Cert:\CurrentUser\My   | Where-Object Subject -match "Valentin Pitel \(test\)" | Remove-Item
Remove-Item .\test.exe, $env:TEMP\test.cer
```

---

## Aide-mémoire

| Besoin | Commande |
|---|---|
| Poste sur le domaine ? | `(Get-CimInstance Win32_ComputerSystem).PartOfDomain` |
| Lister les CA d'entreprise | requête ADSI `Enrollment Services` (étape 0.2) |
| Racine interne de confiance ? | `Get-ChildItem Cert:\LocalMachine\Root \| ? Subject -match "almavia"` |
| Demander un cert (GUI) | `certmgr.msc` → Personnel → Demander un nouveau certificat |
| Thumbprint | `Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert` |
| Signer (PowerShell) | `Set-AuthenticodeSignature -FilePath … -Certificate … -TimestampServer …` |
| Vérifier la signature | `Get-AuthenticodeSignature … \| Format-List Status, …` |
