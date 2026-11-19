# Claude-Code-Sitzungsverwaltung – Spezifikation

Dieses Dokument beschreibt ein selbst gehostetes Web-Frontend, mit dem Claude-Code-Sitzungen auf dem Heimserver verwaltet werden. Es dient als Arbeitsgrundlage für eine Implementierungs-Session.

## Ziel und Motivation

Auf dem Server liegen inzwischen viele Repositories. Die bisherigen Wege (Devbox-VM per RDP im Browser, CloudCLI, T3 Code) sind umständlich, vor allem beim Umgang mit Git-Worktrees. Außerdem fehlt die Möglichkeit, mehrere Repositories in derselben Konversation zu bearbeiten. Das neue Frontend soll Sitzungen, Repositories und deren Arbeitskopien an einer Stelle bündeln.

**Grundprinzip volle Rechte:** Das Frontend ist keine Sandbox, sondern ein Web-Frontend für Claude Code auf der Maschine, auf der es läuft (der Devbox des Besitzers). Eine Sitzung kann alles, was eine Claude-Code-Sitzung kann, die der Nutzer auf dieser Maschine im Terminal oder in der GUI startet: dasselbe `~/.claude` (Login, Skills, Plugins, MCP-Server, Memory, CLAUDE.md, Einstellungen), dieselben Git- und GitHub-Zugangsdaten (`gh`-Login, SSH-Schlüssel), `sudo`, Geräte, Docker, das ganze Dateisystem. Was das Frontend dazugibt, bleibt: Sitzungsverwaltung, Multi-Repo-Sitzungen mit eigenen Klonen pro Sitzung (Isolation paralleler Sitzungen voneinander), PR-Automatik, Benachrichtigungen und PWA, Vorschauen, die mobile Oberfläche.

**Grundprinzip Multi-Repo:** Eine Sitzung arbeitet von Anfang an mit beliebig vielen Repositories gleichzeitig. Datenmodell, Verwaltung der Sitzungsklone, Diff-Ansicht, Dev-Server-Vorschau, GitHub-Referenzen, PR-Automatik und Aufräumen sind deshalb immer pro Sitzung mit mehreren Repos ausgelegt, nie mit der Annahme „eine Sitzung = ein Repo“. Eine Sitzung kann damit auch mehrere PRs haben, einen pro geändertem Repository.

## Kernfunktionen

1. **Repository-Übersicht:** Der GitHub-Account ist angebunden. Beim Start einer Sitzung lassen sich alle Repositories auswählen, auf die der Account Zugriff hat, auch aus Organisationen. Ein gewähltes Repo wird beim ersten Mal als lokaler Spiegel ins Volume geklont, danach nur noch aktualisiert; jede Sitzung bekommt daraus einen eigenen Klon. Lokal vorhandene Repos werden mit Branch, Sitzungsklonen und Sitzungen angezeigt.
2. **Neue Sitzung starten:** Auswahl eines Haupt-Repositories plus optional weiterer Repositories. Für jedes gewählte Repository wird automatisch ein eigener Sitzungsklon mit neuem Branch angelegt.
3. **Neues Projekt ohne Repo:** Eine Sitzung kann auch in einem neuen, leeren lokalen Projekt gestartet werden, ganz ohne bestehendes GitHub-Repo. Das Projekt ist ein Repository ohne Remote (lokaler Spiegel mit `git init`); weitere Sitzungen arbeiten darauf wie auf jedem Repository in eigenen Klonen. Sitzungen ganz ohne Repository bekommen ein eigenes leeres Scratch-Verzeichnis. Bei Bedarf legt das Frontend über die GitHub App ein neues Repository im Account oder in einer Organisation an und verknüpft es als Remote.
4. **Multi-Repo-Sitzungen:** Das Haupt-Repository ist das Arbeitsverzeichnis, die weiteren Repositories werden als zusätzliche Verzeichnisse freigegeben. Auch einer laufenden Sitzung lässt sich ein weiteres Repository hinzufügen, damit Claude in derselben Konversation weiterarbeitet: in den Sitzungsdetails mit denselben Auswahlmöglichkeiten wie beim Start (registriertes Repository, GitHub, URL, lokales Projekt, Basis-Branch) oder durch Claude selbst über das Tool `add_repository`, das wie jedes Tool je nach Berechtigungsmodus nachfragt (die Freigabe zeigt Repository, Herkunft, Basis-Branch und Claudes Begründung). Das hinzugefügte Repository bekommt einen eigenen Klon auf dem Sitzungs-Branch, sein Setup-Skript läuft, und es verhält sich danach wie die übrigen (Diff, Push, PR, `@`/`#`, Aufräumen). Der laufende Claude-Code-Prozess übernimmt das Verzeichnis ohne Neustart, auch mitten im Turn. Scheitert der Klon oder das Setup-Skript, bleibt die Sitzung nutzbar; das Repository lässt sich erneut versuchen, trotzdem verwenden (nach fehlgeschlagenem Setup) oder wieder entfernen. Ein Repository aus einer laufenden Sitzung zu entfernen, ist nicht vorgesehen.
5. **Chat-Ansicht:** Live-Streaming der Antworten, Tool-Aufrufe und Dateiänderungen, jede Änderung direkt als Diff im Verlauf. Dazu eine Diff-Ansicht der gesamten Sitzung gegenüber dem Basis-Branch (ab der Merge-Basis wie bei einem Pull Request, sodass hereingemergte Änderungen des Basis-Branches nicht als Änderungen der Sitzung erscheinen), pro Repository und Datei, wahlweise nebeneinander oder untereinander; Eingabe neuer Nachrichten; Abbrechen einer laufenden Antwort.
6. **Sitzungen fortsetzen:** Liste aller Sitzungen mit Status (läuft, wartet, beendet). Beendete Sitzungen lassen sich über ihre Sitzungs-ID wieder aufnehmen.
7. **Berechtigungen:** Rückfragen von Claude zu Tool-Freigaben werden im Frontend als Dialog angezeigt und dort bestätigt oder abgelehnt. Der Berechtigungsmodus ist pro Sitzung wählbar.
   - **Umsetzung (entschieden):** Wählbar sind `default` (Fragen), `acceptEdits`, `auto`, `plan`, `dontAsk` und `bypassPermissions` (in der Oberfläche als gefährlich markiert: alles läuft ohne Rückfrage mit allen Rechten des Nutzers). In `auto` entscheidet der Klassifikator von Claude Code über jeden Tool-Aufruf und fragt den Nutzer nur, wenn er unsicher ist. Die App setzt keine eigenen Grenzen: `git push`, `create_pull_request` und `add_repository` folgen wie jedes Tool dem Modus und den Regeln (auch „für diese Sitzung“ erlaubt). Ein Autofix-Lauf (nicht vertrauenswürdiger GitHub-Inhalt) läuft in `auto`- und `bypassPermissions`-Sitzungen bis zum Ende seines Turns als `default`, und in jedem Modus geht jeder Tool-Aufruf außer Lesen an den Nutzer, auch wenn Erlaubnis-Regeln (eigene, des Projekts, „für diese Sitzung“) ihn sonst durchließen; die eigene Freigabe von `git add`/`commit`/`push` des Sitzungs-Branches bleibt. Ist der gewählte Modus nicht verfügbar (`auto`: Plan, Modell, Einstellungen; `bypassPermissions`: in den Einstellungen abgeschaltet), läuft Claude Code als `default`; gewählt bleibt der Modus, die Oberfläche zeigt den wirksamen Modus mit Hinweis. Im Plan-Modus kein Klassifikator.
8. **Aufräumen der Sitzungsklone:** Nach Abschluss einer Sitzung lassen sich ihre Klone mergen, pushen oder verwerfen, inklusive Diff-Ansicht vorher.

## Architektur

- **Projektstruktur:** Nx-Monorepo mit Angular-Frontend und NestJS-Backend als eigenen Apps sowie gemeinsamen Bibliotheken, etwa für die Typen der Sitzungsereignisse.
- **Backend:** NestJS (Node.js, TypeScript) und dem Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). Das SDK liefert dieselbe Agent-Schleife wie Claude Code. Das Backend verwaltet Sitzungen, Repositories, Sitzungsklone und den Git-Zugriff.
- **Kommunikation:** REST für Verwaltungsaktionen, WebSocket oder Server-Sent Events für das Streaming der Sitzungsereignisse.
- **Frontend:** Angular-Single-Page-App, responsiv, damit es auch am Handy nutzbar ist.
- **Persistenz:** SQLite für Metadaten (Sitzungen, zugehörige Repos und Sitzungsklone, Titel, Zeitstempel). Die eigentlichen Gesprächsverläufe speichert Claude Code selbst.
- **Betrieb:** systemd-Dienst über das NixOS-Modul auf der Devbox, als Benutzer des Besitzers (oder Docker-Container, siehe Laufzeitumgebung), erreichbar über den bestehenden Cloudflare Tunnel mit Google Single Sign-On über Cloudflare Access davor (gilt auch für die Vorschau-Subdomains; nur der GitHub-Webhook-Pfad wird per Bypass-Regel ausgenommen). Keine eigene Anmeldung in der App.
- **Prüfung des Access-Tokens im Backend:** Das Backend verlässt sich nicht allein darauf, dass Cloudflare Access davor sitzt, sondern prüft das Access-JWT jeder Anfrage und jedes WebSocket-Aufbaus selbst (Signatur über die Schlüssel des Teams, Aussteller, Audience der Anwendung, Ablauf; optional eine Liste erlaubter E-Mail-Adressen). Grund: Alles, was den Port des Containers ohne Umweg über Cloudflare erreicht – ein anderer Prozess im Container, der Host, das lokale Netz –, könnte sonst die API bedienen und etwa ohne Freigabe des Nutzers pushen. Ausgenommen sind nur der Health-Check und der Webhook (Signatur). Für die lokale Entwicklung lässt sich die Prüfung ausdrücklich abschalten. Prozesse der Sitzungen dürfen die Verwaltungs-API nicht aufrufen (etwa um ihre eigenen Freigaben zu beantworten): im Container erkennt das Backend sie am eigenen Benutzer, auf der Devbox (Dienst und Sitzungen laufen als derselbe Benutzer) daran, dass das Backend sie gestartet hat (Prozessbaum, cgroup des Dienstes). Andere Programme des Nutzers auf der Maschine und der Tunnel von einem anderen Rechner sind davon nicht betroffen. Das ist eine Schutzmaßnahme gegen Versehen, keine Grenze: Mit den Rechten des Nutzers kann eine Sitzung auch die Datenbank und die Secrets der App lesen (bewusst in Kauf genommen).

## Konzept der Sitzungsklone

- Pro Repository gibt es einen lokalen Spiegel (bare Repository) unter `<workspace>/repos/<owner>/<repo>`. Er wird einmal aus dem Netz geklont und danach nur noch aktualisiert; niemand arbeitet darin.
- Jede Sitzung bekommt pro Repository einen eigenen, vollständigen Klon dieses Spiegels unter `<workspace>/sessions/<sitzungs-slug>/<owner>/<repo>`. Der lokale Klon verlinkt die Git-Objekte per Hardlink (gleiches Dateisystem) und kostet daher kaum Platz und keinen Netzverkehr; `origin` zeigt auf das echte Remote.
- Grund: vollständige Isolation. Refs, Stash, Tags, Konfiguration, Hooks und Index gehören allein dem Klon der Sitzung, sodass parallele Sitzungen im selben Repository sich nie in die Quere kommen; zugleich wird nicht für jede Sitzung erneut aus dem Netz geklont.
- Branch-Namensschema: `claude/<sitzungs-slug>`.
- Eine Sitzung kennt alle ihre Klone; beim Aufräumen werden sie gemeinsam behandelt. Verwerfen heißt, das Verzeichnis der Sitzung zu löschen.
- Verwaiste Sitzungsklone (ohne zugehörige Sitzung) werden in der Übersicht markiert.
- **Umsetzung (entschieden):** Aufräumen geht erst, wenn die Sitzung beendet ist (beim Archivieren wird sie dafür beendet); pro Verzeichnis Push des Sitzungs-Branches (Repos mit Remote, nie Force), Fast-Forward des Basis-Branches (lokale Projekte), Verwerfen oder Behalten (Standard). Was verloren ginge (uncommittete Dateien, Commits ohne Remote, Stash-Einträge), wird vorher gezeigt; ein Verzeichnis mit solcher Arbeit wird nur nach ausdrücklicher Bestätigung gelöscht. Danach bleibt die Sitzung lesbar, lässt sich aber nicht fortsetzen. Gelöscht wird nur innerhalb von `sessions/` und `scratch/`, ohne Symlinks zu folgen und ohne die Rechte des Backends (im Container als Sitzungsbenutzer bzw. ohne Capabilities). Verwaiste Verzeichnisse und fehlende Sitzungsverzeichnisse zeigt eine eigene Seite mit Inhalt und Größe; Entfernen nur nach Bestätigung.

## GitHub-Referenzen im Prompt

Im Eingabefeld lassen sich Issues und Pull Requests wie in GitHub referenzieren.

- **Autovervollständigung:** Bei Eingabe von `#` erscheint eine Auswahl passender Issues und PRs aus den Repos der Sitzung, durchsuchbar nach Nummer und Titel. Andere Repos über `owner/repo#123`.
- **Anzeige:** Referenzen erscheinen im Prompt und im Verlauf als Chip mit Titel, Status (offen, gemerged, geschlossen) und Link; beim Überfahren eine kurze Vorschau.
- **Kontext für Claude:** Beim Absenden hängt das Backend Titel, Beschreibung und auf Wunsch Kommentare bzw. den Diff des PRs als Kontext an.
- **Datenquelle:** GitHub-API über die GitHub App, mit kurzem Cache.
- **Umsetzung (entschieden):** Kommentare und PR-Diff wählt der Nutzer pro Referenz in der Vorschau des Chips (Standard: aus); die Vorschau öffnet beim Überfahren mit der Maus und beim Antippen. Größen sind begrenzt (Beschreibung, die neuesten 50 Kommentare, Diff, Gesamtkontext); Gekürztes wird Claude und dem Nutzer gesagt. Nicht auflösbare Referenzen (nicht gefunden, Rate-Limit, GitHub nicht erreichbar) halten die Nachricht nicht auf: der Chip zeigt es, Claude erfährt, dass der Inhalt fehlt. Der Inhalt aus GitHub gilt als nicht vertrauenswürdig: Er geht als eigene, markierte Nachricht vor der Nachricht des Nutzers an Claude, ohne `@`-Expansion und Slash-Commands, und ist im Verlauf aufklappbar; dieselbe Schnittstelle nutzt die PR-Automatik.

## PR-Automatik pro Sitzung

Zu jeder Sitzung mit offenem Pull Request lassen sich Automatiken ein- und ausschalten.

- **Autofix:** Schlägt ein CI-Check fehl oder kommt ein neuer Review-Kommentar, setzt das Backend die Sitzung automatisch mit diesem Kontext fort; Claude behebt das Problem und pusht auf den Sitzungs-Branch.
- **Autoclose:** Wird der PR gemerged oder geschlossen, wird die Sitzung beendet, ihre Dev-Server gestoppt und die Sitzungsklone aufgeräumt.
- **Ereignisquelle:** GitHub-Webhooks der GitHub App. Der Webhook-Endpunkt muss am SSO vorbei erreichbar sein und prüft die Webhook-Signatur; alternativ regelmäßiges Abfragen per Polling.
- **Grenzen:** Maximale Anzahl automatischer Fix-Versuche pro PR, danach Benachrichtigung statt weiterer Versuche.
- **Umsetzung (entschieden):** Beide Schalter pro PR, Standard aus; Versuchslimit pro PR (Standard 3, einstellbar), gezählt in der Datenbank, zurückgesetzt nur durch den Nutzer. Webhook und Polling sind nur Anlass, den Stand über die API zu lesen. Auslöser sind fehlgeschlagene Checks des aktuellen Head-Commits (ältere Commits und laufende Checks zählen nicht) und neue Reviews, Review-Kommentare und Kommentare im PR von Nutzern mit Schreibrecht (keine Bots, nicht die App selbst). Was zusammen eintrifft, wird ein Lauf; während die Sitzung arbeitet oder auf den Nutzer wartet, startet kein Lauf, danach wird neu geprüft. Kontext von GitHub (Check-Ausgabe, Log-Auszug, Kommentare) geht nur als nicht vertrauenswürdiger Kontext an Claude. Während Autofix führt die App `git add`, `git commit` und den Push genau des Sitzungs-Branches ohne Rückfrage selbst aus, auch mit `&&` verbunden, wenn der Befehl nichts anderes enthält (Hooks aus, kein Force, keine Tags, nichts Löschendes, kein Amend gepushter Commits, keine Workflow-Änderungen); alles andere bleibt beim Freigabe-Dialog. Mehrere PRs einer Sitzung: Schalter und Zähler pro PR, ein Lauf zur Zeit; Autoclose erst, wenn kein PR der Sitzung mehr offen ist. Klone mit Arbeit, die nicht auf GitHub liegt, bleiben erhalten und lassen sich nach Bestätigung löschen.

## Benachrichtigungen

Sitzungen arbeiten meist unbeobachtet, daher meldet das Backend wichtige Ereignisse aktiv. Beide Kanäle werden unterstützt und sind einzeln schaltbar.

- **Web Push:** Das Angular-Frontend ist eine PWA mit Service Worker; Push über Web Push mit VAPID-Schlüsseln. Auf iOS nur, wenn die App zum Home-Bildschirm hinzugefügt ist.
- **ntfy:** Das Backend sendet zusätzlich an einen konfigurierbaren ntfy-Server und -Topic und authentifiziert sich dabei mit einem Access-Token (Bearer-Header). Der Token ist Pflicht und wird als Secret übergeben, nicht im Image oder in der Datenbank im Klartext.
- **Ereignisse:** Claude wartet auf eine Freigabe, Sitzung ist fertig oder hängt, Autofix gibt nach dem Versuchslimit auf, PR wurde gemerged oder geschlossen.
- **Ziel:** Ein Tipp auf die Benachrichtigung öffnet direkt die betreffende Sitzung (für ntfy-Links über die öffentliche URL der App, `PUBLIC_URL`).
- **Einstellungen:** Pro Ereignistyp und Kanal ein- und ausschaltbar.
- **Festlegungen:** „Fertig“ heißt: ein Turn ist zu Ende und Claude wartet auf die nächste Nachricht (das ausdrückliche Beenden einer Sitzung meldet nichts). „Hängt“ heißt: Status `running` und seit `SESSION_STALL_MINUTES` (Standard 15) kein Ereignis von Claude; einmal pro Hänger, erneut erst nach neuer Aktivität. Eine fehlgeschlagene Sitzung (auch ein fehlgeschlagenes Setup-Skript) meldet sofort. Rückfragen von Claude melden wie Freigaben, ohne Erlauben/Ablehnen. Inhalt: Sitzungstitel, Repositories, bei Freigaben Aktion mit gekürztem Befehl oder Dateipfad.
- **Nur was aktuell ist:** Zu einer Sitzung, die ein Client gerade sichtbar und aktiv zeigt, wird nichts gemeldet. Nicht mehr aktuelle Benachrichtigungen werden zurückgezogen (Web Push: per Tag geschlossen, außer auf Apple-Geräten; ntfy: per Sequenz-ID gelöscht).

## PWA-Funktionen

Das Angular-Frontend nutzt als installierbare PWA zusätzlich:

- **Aktionen in Benachrichtigungen:** Freigabe-Anfragen lassen sich direkt in der Push-Nachricht mit „Erlauben“ oder „Ablehnen“ beantworten, ohne die App zu öffnen. „Erlauben“ heißt einmal erlauben (nie für die ganze Sitzung, kein Moduswechsel); Pushes, die mehr als den Sitzungs-Branch ändern, bekommen kein „Erlauben“. Kommt die Antwort nicht an (Access abgelaufen, offline), öffnet sich die Sitzung mit der weiter offenen Anfrage.
- **Badge am App-Icon:** Badging API zeigt die Zahl der Sitzungen, die auf den Nutzer warten: offene Freigabe, Rückfrage oder Plan, oder ein fehlgeschlagenes Setup-Skript, das die erste Nachricht zurückhält; eine Sitzung, deren Turn fertig ist und die nur auf die nächste Nachricht wartet, zählt nicht. „Wartende Sitzungen“ zeigt genau diese.
- **Share Target:** Links, Screenshots oder Text aus anderen Apps lassen sich an die PWA teilen und werden zum Prompt einer neuen Sitzung (das Formular wird vorausgefüllt; der Service Worker nimmt den Upload selbst entgegen, die API bleibt bei JSON).
- **App-Shortcuts:** Langes Drücken auf das Icon bietet „Neue Sitzung“ und „Wartende Sitzungen“.
- **Offline-Shell:** Die App startet sofort und zeigt den zuletzt bekannten Stand der Sitzungsliste, auch bei kurzer Verbindungsunterbrechung.
- **Hinweis Cloudflare Access:** Läuft die Access-Sitzung ab, kann die installierte PWA auf der Login-Seite hängen bleiben. Lange Sitzungsdauer in Access wählen und abgelaufene Anmeldung im Frontend erkennen und sauber zur Neuanmeldung führen.

## Weitere Sitzungsfunktionen

- **Modell und Plan-Modus:** Modell pro Sitzung wählbar (z. B. Opus oder Sonnet), auch während der Sitzung umschaltbar; Plan-Modus, in dem Claude zuerst einen Plan vorlegt und erst nach Freigabe umsetzt.
- **Dateien per @:** Im Eingabefeld Dateien aus allen Klonen der Sitzung per `@` mit Autovervollständigung referenzieren.
- **Bilder anhängen:** Screenshots einfügen, per Drag-and-drop oder Upload an den Prompt hängen.
- **Nachrichten einreihen:** Während Claude arbeitet, lassen sich weitere Nachrichten schreiben; sie werden eingereiht und nach dem aktuellen Schritt verarbeitet.
- **To-do-Liste und Kontext:** Claudes Aufgabenliste wird live angezeigt, ebenso die Auslastung des Kontextfensters.
- **Setup-Skripte pro Repo:** Pro Repository ein konfigurierbares Skript (z. B. `npm install`), das nach dem Anlegen eines Sitzungsklons läuft.
- **Sitzungen verwalten:** Umbenennen, archivieren, durchsuchen.
  - **Umsetzung (entschieden):** Umbenennen ändert nur den Titel (Slug, Branches und Verzeichnisse bleiben). Archivieren beendet die Sitzung, bietet das Aufräumen der Klone im selben Schritt an und blendet sie aus der Liste aus; archivierte Sitzungen bleiben lesbar und durchsuchbar, nehmen keine Nachrichten an und lassen sich wieder einblenden. Beendete oder archivierte Sitzungen lassen sich endgültig löschen (Verlauf, Transkript, Bilder, gezeigte Dateien, Klone) nach einem Dialog, der sagt, was verloren geht; ihr Verbrauch bleibt in der Statistik mit Titel und Repositories. Die Suche ist eine Volltextsuche über Titel, Repositories, Branches und den Gesprächstext (Nachrichten des Nutzers und Antworten von Claude), auch archivierter Sitzungen; Treffer führen an die Stelle im Verlauf.

## Anzeige von Kontext- und Abo-Limits

Die Oberfläche zeigt jederzeit, wie viel Spielraum noch bleibt. Drei Werte sind sichtbar:

- **Kontextlimit:** Auslastung des Kontextfensters der jeweiligen Sitzung (belegte und maximale Tokens, Prozent), live in der Sitzungsansicht.
- **Session-Limit:** Verbrauch im aktuellen 5-Stunden-Fenster des Abos, mit Prozentwert und Zeitpunkt des Zurücksetzens.
- **Wochenlimit:** Verbrauch im aktuellen Wochenfenster des Abos, mit Prozentwert und Zeitpunkt des Zurücksetzens; falls das Abo getrennte Wochenlimits pro Modell ausweist, werden diese einzeln angezeigt.

Session- und Wochenlimit gelten für das ganze Konto und sind deshalb global sichtbar (z. B. in der Kopfzeile bzw. Sitzungsliste), nicht nur innerhalb einer Sitzung. Die Werte stammen aus den Limit-Informationen, die Claude Code bzw. das Agent SDK liefert, und werden bei jeder Anfrage aktualisiert.

## Dateien zeigen

Claude kann dem Nutzer von sich aus eine Datei zeigen, etwa einen erzeugten Screenshot, ein Bild, einen Bericht oder eine HTML-Seite. Gemeint ist ausdrücklich kein allgemeiner Dateibrowser, sondern dass Claude eine bestimmte Datei gezielt vorlegt.

- **Tool:** Das Backend stellt Claude über das SDK ein eigenes Tool `show_file` (Pfad, optionale Bildunterschrift) bereit. Erlaubt sind nur Dateien aus den Verzeichnissen der Sitzung.
- **Anzeige:** Die Datei erscheint als Karte im Verlauf und lässt sich in einer Seitenansicht öffnen: Bilder direkt, Markdown und HTML gerendert, Code und Text mit Syntax-Highlighting, PDF eingebettet; alles andere als Download.
- **Bilder im Verlauf:** Bilder, die Claude zeigt, erzeugt oder liest, erscheinen als Miniatur direkt im Chat, ohne Klick.
- **Stand der Datei:** Gezeigt wird der Inhalt zum Zeitpunkt des Zeigens; er bleibt im Verlauf sichtbar, auch wenn die Datei später geändert oder die Sitzung aufgeräumt wird.
- **Benachrichtigung:** Gezeigte Dateien lösen keine eigene Benachrichtigung aus.

## Statistik und Kosten

Das Backend protokolliert den Verbrauch jeder Sitzung und zeigt ihn im Frontend über die Zeit an.

- **Erfassung:** Aus den Ergebnis-Nachrichten des Agent SDK pro Anfrage die Token-Zahlen (Eingabe, Ausgabe, Cache-Schreiben, Cache-Lesen), das Modell und die vom SDK berechneten theoretischen Kosten in USD; gespeichert in SQLite.
- **Theoretische API-Kosten:** Was die Nutzung bei Abrechnung über die API gekostet hätte, obwohl über das Abo gearbeitet wird.
- **Auswertung:** Verbrauch und Kosten über die Zeit (Tag, Woche, Monat) als Diagramm, aufgeteilt nach Sitzung, Repository und Modell.
- **Pro Sitzung:** Summe von Tokens und theoretischen Kosten direkt in der Sitzungsansicht.
- **Umsetzung (entschieden):** Tages-, Wochen- (Montag bis Sonntag) und Monatsgrenzen in der Zeitzone des Browsers. Eine Sitzung mit mehreren Repositories zählt einmal unter allen zusammen (z. B. `acme/app + acme/lib`), damit die Gruppen die Summe ergeben. Unterbrochene Anfragen fehlen in den Zahlen des SDK; sie werden nicht geschätzt.

## Vorschau von Dev-Servern

Claude kann in einer Sitzung Dev-Server starten, die das Backend als Vorschau ins Frontend durchreicht.

- **Start:** Claude startet den Dev-Server als Hintergrundprozess im Container, im Klon der Sitzung.
- **Port melden:** Das Backend stellt Claude über das SDK ein eigenes Tool `expose_port` (Port, Name) bereit. Optional erkennt das Backend zusätzlich neu lauschende Ports der Sitzung automatisch.
- **Weiterleitung:** NestJS leitet als Reverse Proxy weiter, inklusive WebSockets für Hot Reload.
- **Adressen:** Eigene Subdomain pro Vorschau, z. B. `<sitzung>-<port>.preview.<domain>`, statt Unterpfaden (vermeidet Probleme mit Asset-Pfaden und Hot Reload). Dazu ein Wildcard-Eintrag im Cloudflare Tunnel; die Vorschau liegt ebenfalls hinter SSO.
- **Frontend:** Laufende Vorschauen erscheinen in der Sitzung als Link und optional als eingebettete Ansicht.
- **Aufräumen:** Beim Beenden oder Aufräumen einer Sitzung werden ihre Dev-Server gestoppt und die Weiterleitungen entfernt.
- **Umsetzung (entschieden):** `expose_port` braucht keine Freigabe; Claude kann eine Vorschau mit `stop_preview` beenden, der Nutzer per Knopf. Weitergeleitet werden nur Ports, auf denen ein Prozess des Sitzungsbenutzers auf Loopback lauscht (nie der Port der App), geprüft bei jeder Verbindung. Der Dev-Server sieht die Anfragen wie lokal (`Host`/`Origin` `localhost:<port>`), ohne Access-Token, Cloudflare- und Weiterleitungs-Header. Vorschau-Hosts liefern nichts von der App, der App-Host keine Vorschau; mit Cloudflare Access haben die Vorschauen eine eigene Access-Anwendung mit eigener Audience, deren Token die API nicht annimmt. Die eingebettete Ansicht ist ein Frame mit `sandbox` ohne Top-Navigation. „Stopp“ beendet nur die Weiterleitung; beim Ende der Sitzung werden auch die Prozesse hinter ihren Ports beendet (läuft alles als ein Benutzer, nur die, die das Backend gestartet hat). Keine automatische Erkennung neuer Ports: Alle Sitzungen laufen als derselbe Benutzer, ein Port lässt sich keiner Sitzung sicher zuordnen.

## Laufzeitumgebung und Container

Zwei Wege, beide gebaut und getestet:

- **NixOS-Dienst (Hauptweg, Devbox):** Das NixOS-Modul startet Backend, Frontend und die Claude-Code-Prozesse als systemd-Dienst des Benutzers, den die Konfiguration nennt (`services.claude-remote-manager.user`, auf der Devbox der Login-Benutzer des Besitzers).
  - **Umsetzung (entschieden):** Keine Sandbox und keine Trennung von Dienst- und Sitzungsbenutzer: keine systemd-Härtung (`ProtectSystem`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `NoNewPrivileges`, Syscall-Filter, versteckte Pfade), keine Capabilities. Sitzungen nutzen das `~/.claude` des Benutzers (kein eigenes `CLAUDE_CONFIG_DIR`; Einstellungen, Skills, Plugins, MCP-Server und claude.ai-Connectors wie im Terminal), seine Git-Konfiguration, `gh` und SSH-Schlüssel, `sudo`, Geräte und Docker; der `PATH` ist der einer Login-Shell des Benutzers (`/run/wrappers/bin` zuerst). Die Secrets der App (GitHub-App-Schlüssel, ntfy-Token, Datenbank) kommen als systemd-Credentials und sind für Sitzungen lesbar; das ist in Kauf genommen. Die eigenen Git-Befehle des Backends auf den Spiegeln nutzen Installation-Tokens und eine eigene Git-Konfiguration (`API_GIT_CONFIG_GLOBAL`), damit Einstellungen des Nutzers (URL-Umschreibungen, Signieren) sie nicht ändern. Anweisungen für alle Sitzungen dieser Maschine (Verzeichnisse, NixOS, `extraInstructions`) hängt das Backend an den System-Prompt an, statt eine maschinenweite `/etc/claude-code/CLAUDE.md` zu schreiben, die auch die Terminal-Sitzungen des Nutzers laden würden.
  - **Umsetzung (entschieden), Umstieg von der Version mit getrennten Benutzern:** Der Dienst übergibt das Datenverzeichnis beim ersten Start einmal rekursiv an den Benutzer (eine Stempeldatei merkt sich, an wen). Die Transkripte alter Sitzungen liegen im alten Konfigurationsverzeichnis `<dataDir>/claude`; das Backend kopiert beim Start einmal alles aus dessen `projects/`, was in `~/.claude/projects/` fehlt (die Projektnamen sind die unveränderten Klonpfade), und verschiebt das Repository-Memory nach `<dataDir>/memory`, damit alte Sitzungen fortgesetzt werden können. Nichts wird überschrieben oder gelöscht; eine Markierungsdatei verhindert eine Wiederholung. Den alten Login übernimmt es nicht. Den alten Credential-Helper der App entfernt es aus einem Klon beim nächsten Start eines Claude-Code-Prozesses der Sitzung.
- **Docker-Container:** NestJS-Backend, ausgeliefertes Angular-Frontend und die Claude-Code-Prozesse in einem Container.
  - **Image unabhängig vom Host:** normales Dockerfile, keine Annahmen über NixOS auf dem Host. Das Image muss auf jedem Docker-Host laufen.
  - **Nix im Container:** Im Image ist Nix (Single-User, Flakes aktiviert) installiert. Repositories bringen ihre Werkzeuge über eine eigene `flake.nix` mit Dev-Shell mit; Claude führt Builds und Tests in dieser Umgebung aus (z. B. über `nix develop` oder direnv).
  - **Fallback:** Repos ohne Flake starten mit einer kleinen Grundausstattung im Image (git, Node.js). Fehlende Werkzeuge holt sich Claude bei Bedarf selbst über Nix, z. B. mit `nix shell nixpkgs#dotnet-sdk`.
  - **Volumes:** Arbeitsbereich mit Spiegeln, Sitzungsklonen und Scratch-Verzeichnissen (ein Volume, damit Hardlinks möglich sind), das Claude-Verzeichnis (Login, Sitzungsverläufe), SSH-Key bzw. Git-Zugangsdaten, SQLite-Datenbank sowie der Nix-Store als Cache, damit Werkzeuge nicht bei jedem Neustart neu geladen werden.
  - **Benutzer:** Im Container laufen Backend und Sitzungen weiterhin als getrennte Benutzer; die Sitzungen erreichen die Daten der App nicht. Git-Zugangsdaten der App bekommen sie nicht mehr: Für eigene Pushes braucht der Sitzungsbenutzer eigene, sonst pusht der Nutzer per Knopf.

**Claude-Anmeldung:** Claude Code meldet sich über das Claude-Konto (Abo) an, nicht per API-Key. Auf der Devbox ist es der Login des Benutzers in `~/.claude`, im Container liegen die Anmeldedaten im Volume des Claude-Verzeichnisses und überstehen so Neustarts.

## Globale CLAUDE.md im Container

Eine globale CLAUDE.md im Image (bzw. im Claude-Verzeichnis; auf dem NixOS-Dienst als Anhang an den System-Prompt) gibt allen Sitzungen gemeinsame Regeln vor. Erste Punkte, noch zu ergänzen:

- **Werkzeuge:** Fehlende Tools über Nix holen; Repos mit `flake.nix` immer in deren Dev-Shell bauen und testen.
- **Sitzungsklone:** Nur in den Klonen der eigenen Sitzung arbeiten, nie im lokalen Spiegel eines Repos.
- **Mehrere Repos:** Zusätzliche Repositories liegen als eigene Sitzungsklone vor; Änderungen dort ebenfalls nur auf dem Sitzungs-Branch.
- **Verzeichnisse:** Feste Struktur für Spiegel, Sitzungsklone und Scratch-Verzeichnisse.
- **Git:** Claude darf selbst committen und den Sitzungs-Branch mit den Zugangsdaten des Benutzers pushen (gefragt wird je nach Berechtigungsmodus); andere Branches, Force-Push und das Umschreiben veröffentlichter Historie nur auf ausdrücklichen Wunsch.

## GitHub-Anbindung

Die Anbindung läuft über eine eigene GitHub App.

- Die App wird im Nutzer-Account und in den gewünschten Organisationen installiert; dort wird festgelegt, auf welche Repositories sie zugreift.
- Das Backend erzeugt daraus kurzlebige Installation-Tokens für Repo-Liste, Klonen, Pushen per Knopf, PRs und die PR-Automatik. Sitzungen bekommen keine.
- Private Key und App-ID liegen als Secrets im Container, nicht im Image.

**Pushen und Pull Requests:** Beides geht auf zwei Wegen.

- **Per Knopf:** Die Oberfläche bietet pro Repository der Sitzung „Push“ und „PR erstellen“ an; das Backend führt es mit einem Installation-Token aus.
- **Durch Claude:** Claude kann den Sitzungs-Branch selbst pushen (`git push` mit den Zugangsdaten des Benutzers: Git-Konfiguration, `gh`-Credential-Helper, SSH, wie im Terminal) und über ein eigenes Tool `create_pull_request` (Repository, Titel, Beschreibung, Basis-Branch) einen PR anlegen, den die Sitzung dann anzeigt und die PR-Automatik verfolgt. Ob dafür gefragt wird, entscheidet der Berechtigungsmodus der Sitzung wie bei jedem Tool.
  - **Umsetzung (entschieden):** Der frühere Credential-Helper der App, der GitHub-App-Tokens nur nach einer Freigabe herausgab, entfällt samt Endpunkt und Sitzungs-Tokens. `origin` eines GitHub-Klons ist die HTTPS-URL, sodass der Credential-Helper des Nutzers für `https://github.com` greift (oder eine `insteadOf`-Umschreibung auf SSH in seiner Konfiguration). Der Freigabe-Dialog zeigt weiter, was ein `git push` aktualisieren würde, mit Warnungen für alles außer dem Sitzungs-Branch.

## Spätere Ausbaustufen

Nicht Teil der ersten Version, aber in der Architektur mitzudenken:

- **Dateibrowser:** Verzeichnisbaum der Klone einer Sitzung, Dateien mit Syntax-Highlighting ansehen, geänderte Dateien markiert, Dateien per Klick als Referenz in den Prompt übernehmen. **Umsetzung (entschieden):** Eigene Seite „Files“ der Sitzung mit einem Baum pro Verzeichnis (die Dateien wie für `@`: von git verfolgte und unverfolgte, ohne ignorierte), Filter über alle Pfade, von der Sitzung geänderte Dateien (wie auf der Changes-Seite) markiert, Ordner mit Änderungen darunter mit Punkt; Dateien öffnen im vorhandenen Dateiviewer (Highlighting, Markdown, Bilder, PDF, HTML in Sandbox); „Reference in message“ führt zurück in die Sitzung mit `@pfad` im Eingabefeld. Gelesen wird nur innerhalb des Verzeichnisses (auch über Symlinks nicht hinaus).

* **MCP-Server, Slash-Commands und Skills:** Kommen bereits wie im Terminal aus dem `~/.claude` des Benutzers und den Repos. **Umsetzung (entschieden):** Autovervollständigung im Eingabefeld der Sitzung, wenn die Nachricht mit `/` beginnt: die Befehle und Skills, die Claude Code der Sitzung meldet (vor dem ersten Prozess die des Benutzers und die eigenen von Claude Code), ohne die an ein Terminal gebundenen; die Nachricht geht unverändert an Claude Code, das den Befehl ausführt.

## Offene Entscheidungen

- Aufteilung gemeinsamer Typen und Bibliotheken im Nx-Workspace
- Container mit Zugriff auf die Repos per Volume oder Backend direkt auf dem Host
- Rechte der GitHub App im Detail (welche Berechtigungen, Installation pro Organisation)
- Ob mehrere Sitzungen parallel im selben Repository erlaubt sind

## Erste Schritte für die Implementierung

1. **Grundgerüst:** Nx-Workspace mit Angular-App, NestJS-App und gemeinsamer Typen-Bibliothek; Dockerfile mit Nix und Basiswerkzeugen; Container läuft lokal mit Volumes und Claude-Anmeldung über das Konto.
2. **Agent-SDK-Durchstich:** NestJS startet eine Sitzung in einem festen Verzeichnis, streamt Ereignisse per WebSocket, setzt Sitzungen über die ID fort. Minimale Chat-Ansicht im Frontend.
3. **Multi-Repo-Sitzungsklone:** Git-Modul für Spiegel und Sitzungsklone mit Tests, von Anfang an für mehrere Repos pro Sitzung; SQLite-Datenmodell für Sitzungen, Repos und Sitzungsklone; Setup-Skripte pro Repo.
4. **GitHub App:** Repo-Liste inkl. Organisationen, Klonen ins Volume, neue Repos anlegen, Pushen und PRs erstellen.
5. **Vollständige Chat-Ansicht:** Berechtigungsdialoge, Modellwahl und Plan-Modus, Diffs im Verlauf und Gesamt-Diff, To-do-Liste, Kontextanzeige, Nachrichten einreihen, Bilder und @-Dateien, Dateien zeigen (`show_file`).
6. **Betrieb:** Deployment auf dem Server hinter Cloudflare Tunnel mit Google SSO über Cloudflare Access; ab hier im Alltag nutzbar.
7. **Benachrichtigungen und PWA:** ntfy mit Token, Web Push, PWA mit Aktionen in Benachrichtigungen, Badge, Shortcuts, Share Target, Offline-Shell, Umgang mit abgelaufener Access-Sitzung.
8. **GitHub-Referenzen im Prompt.**
9. **PR-Automatik:** Webhooks mit Bypass-Regel und Signaturprüfung, Autofix mit Versuchslimit, Autoclose.
10. **Dev-Server-Vorschau:** `expose_port`-Tool, Reverse Proxy mit WebSockets, Wildcard-Subdomains.
11. **Sitzungen verwalten und aufräumen:** Umbenennen, Archivieren, Suche, Anzeige von Session- und Wochenlimit, Aufräumen der Sitzungsklone und verwaiste Klone; Statistik und theoretische Kosten (die Erfassung der Verbrauchsdaten läuft schon ab Schritt 2 mit).
