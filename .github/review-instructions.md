# Worauf das KI-Review achtet

Anweisungen für das Claude-Review (`.github/workflows/claude-review.yml`). Workflow, Prompt und Skripte liegen im zentralen Reviewer [welles/claude-reviewer](https://github.com/welles/claude-reviewer); was nur für dieses Repo gilt, steht hier.

## Projekt

Claude Remote Manager: eine Weboberfläche, mit der sich Claude-Code-Sitzungen auf einem Rechner aus der Ferne starten, verfolgen und steuern lassen, mit mehreren Repositories pro Sitzung, eigenen Sitzungsklonen, Freigabe-Dialogen, PR-Automatik, Benachrichtigungen und Vorschau von Dev-Servern. Nx-Monorepo: Angular-App in `apps/web`, NestJS-API in `apps/api` mit dem Claude Agent SDK, gemeinsame Typen in `libs/shared-types`, SQLite mit Drizzle; Betrieb als NixOS-Dienst (`nix/`). Die Spezifikation steht in `docs/specification.md`, der Betrieb und die Sicherheitsmechanismen im `README.md`.

## Besonders prüfen

- Freigaben: Kein Weg, auf dem ein Tool-Aufruf ohne die Freigabe läuft, die der gewählte Berechtigungsmodus verlangt. Sitzungen laufen bewusst ohne Sandbox mit den Rechten und Zugangsdaten des Nutzers (`bypassPermissions` ist wählbar); ein Autofix-Lauf läuft im gewählten Modus wie jeder Turn (entschieden 2026-11-20), und die Ausnahmen ohne Rückfrage (Autofix: `git add`/`commit`/`push` des Sitzungs-Branches, Antworten und Auflösen von Review-Threads; `merge_pull_request` nur bei Automerge und bereitem PR) bleiben so eng wie dokumentiert.
- Nicht vertrauenswürdige Inhalte (GitHub-Issues, Kommentare, CI-Logs, Webhooks) gehen nur als markierter Kontext an Claude, nie als Anweisung des Nutzers, ohne `@`-Expansion und Slash-Commands.
- Zugriffsschutz der API: Prüfung von Origin, Host und `Sec-Fetch-Site`, Cloudflare-Access-Token mit Audience, Abweisung von Anfragen aus Sitzungsprozessen, HMAC-Prüfung des Webhooks; Vorschau-Hosts liefern nichts von der App.
- Isolation der Sitzungen: Parallele Sitzungen im selben Repository stören sich nicht (eigene Klone), Pfade aus Eingaben bleiben in ihren Verzeichnissen. Dass Sitzungen auf dem NixOS-Dienst die Secrets der App lesen können, ist entschieden; Installation-Tokens der App gehen trotzdem nie an Sitzungen.
- Daten: Migrationen unter `apps/api/src/app/db/migrations` sind veröffentlicht und werden nie geändert, nur ergänzt; Aufräumen löscht keine Arbeit, die nicht auf GitHub liegt, ohne Bestätigung.
- Nebenläufigkeit im Sitzungsablauf: Zustände von laufenden Prozessen, Warteschlangen, Abbrüche und Neustarts, Rennen zwischen WebSocket-Ereignissen und Anfragen.
- Betrieb: Änderungen, durch die der Nix-Build (`nix/package.nix`, Hash der npm-Abhängigkeiten), das NixOS-Modul oder der Start des Dienstes fehlschlagen, sind mindestens `fehler`.

## Hinweise

`hinweis` sind z. B. fehlende Tests für neues Verhalten, Abweichungen von der Spezifikation ohne Begründung, uneinheitliche Oberfläche und kleine Risiken.

## Bereiche

Sicherheit, Funktion, Daten, Nebenläufigkeit, Oberfläche, Betrieb
