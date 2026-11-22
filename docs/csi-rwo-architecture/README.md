# Architekturentscheidung: CSI-Treiber, Kubernetes und LIO-Zugriffssperren

**Projekt:** OMV mit Ansible · k3s / ZFS / iSCSI  
**Diskussionsstand:** 22.11.2026  
**Status:** Erste Bestandsaufnahme; offene Fragen sind noch nicht abschließend untersucht.

## 1. Ausgangslage und Zielsetzung

Wir entwickeln auf Basis unseres `democratic-csi`-Forks einen CSI-Treiber für RWO-Volumes. Die Volumes liegen als ZFS-ZVOLs auf Storage-Servern und werden über LIO/iSCSI an die k3s-Worker bereitgestellt.

Die zentrale Frage war, **wer für die exklusive Zuweisung eines Volumes verantwortlich ist und ob wir zusätzlich zu Kubernetes eine LIO-basierte Zugriffssperre benötigen.**

Unser Architekturprinzip lautet: Jede Systemschicht soll ihre eigene Verantwortung übernehmen. Der CSI-Treiber soll Kubernetes nicht nachimplementieren.

## 2. Verantwortlichkeiten

| Komponente | Verantwortung |
|---|---|
| **k3s / Kubernetes** | Pod-Lebenszyklus, Scheduling, VolumeAttachments, Attach-/Detach-Koordination |
| **CSI-Controller** | CSI-Anforderungen prüfen, Storage-Operationen ausführen und Erfolg oder Fehler melden |
| **CSI-Node-Plugin** | iSCSI-Login/Logout, Mount/Unmount auf dem Worker |
| **LIO** | ZVOLs exportieren und konfigurierte Zugriffsrechte durchsetzen |
| **ZFS** | Speicherung, ZVOL-Verwaltung, Snapshots |

**Grundsatz:** Kubernetes entscheidet, welcher Node ein Volume erhalten soll. Der CSI-Treiber setzt die angeforderte Storage-Operation um. Er darf eine technisch unzulässige Zuweisung ablehnen.

Dabei ist RWO eine Beschränkung auf einen Node, nicht zwingend auf einen einzelnen Pod.

## 3. Die diskutierten Architekturvarianten

### Option 1 – Kubernetes-gesteuerte Exklusivität

Der CSI-Controller vertraut auf die Attach-/Detach-Koordination von Kubernetes.

`ControllerPublishVolume` und `ControllerUnpublishVolume` führen die notwendigen Storage-Operationen aus. Der Treiber implementiert keinen zusätzlichen persistenten Lock-Manager.

**Vorteile**
- Klare Verantwortungstrennung.
- Geringere Implementierungskomplexität.
- Kein zusätzlicher Lock-Zustand, der nach einem Absturz verwaisen kann.
- Keine eigene Pod-Überwachung oder Recovery-Orchestrierung.
- Einfacher auf mehrere Storage-Server übertragbar.

**Nachteile**
- Ein bereits verbundener iSCSI-Initiator kann bei bestimmten Fehlerzuständen weiterhin auf das Volume zugreifen.
- Kubernetes-RWO ist keine physische Schreibsperre am Storage-Target.
- Der Treiber muss weiterhin die korrekte CSI-Semantik und Idempotenz gewährleisten.

### Option 2 – Kubernetes-Steuerung mit zusätzlicher LIO-ACL-Sperre

Der CSI-Controller setzt bei Publish eine initiatorbezogene LIO-ACL und entfernt sie bei Unpublish.

**Vorteile**
- Zusätzliche Zugriffskontrolle direkt am Storage-Server.
- Nicht autorisierte Initiatoren können technisch ausgesperrt werden.
- Schutz gegen bestimmte Fälle, in denen ein alter Initiator weiterhin Schreibbefehle sendet.

**Nachteile**
- LIO-ACLs sind kein atomarer Lock-Manager.
- Lesen, Entscheiden und Ändern des ACL-Zustands sind nicht automatisch eine atomare Operation.
- Mehrere CSI-Controller können konkurrierende Entscheidungen treffen.
- Bei verteiltem Storage sind Remote-Operationen erforderlich, beispielsweise über SSH.
- Controller-Abstürze können verwaiste ACLs hinterlassen.
- Eine Bestandsaufnahme der LIO-ACLs verrät nicht, ob Kubernetes eine Zuweisung noch benötigt.
- Ein fehlender oder nicht wiederholter Unpublish kann zu einer dauerhaften Blockierung führen.

## 4. Was unser praktischer LIO-Test bewiesen hat

**TESTERGEBNIS · i7srv → pi1**

| Test | Ergebnis |
|---|---|
| Schreiben mit ACL | 16 MiB erfolgreich, 77,3 MB/s |
| Schreiben nach ACL-Entzug | 105,7 s, danach I/O-Fehler; 0 Bytes erfolgreich geschrieben |

Der ACL-Entzug verhinderte den anschließenden Schreibversuch. Das ist ein positiver Nachweis für die Zugriffskontrolle.

Nicht nachgewiesen wurde, ob die bisherige Sitzung unmittelbar und vollständig beendet war und ob ein sofortiger Eigentümerwechsel unter allen Fehlerbedingungen sicher wäre.

Die 105,7 Sekunden sind das beobachtete Fehlerverhalten des Initiators, keine nachgewiesene Wartezeit des CSI-Controllers.

## 5. Das zentrale ungelöste Problem: Wiederherstellung

Ein kritischer Ablauf ist:

1. Kubernetes fordert die Freigabe für Node A an.
2. Der CSI-Controller richtet die LIO-ACL ein.
3. Der Controller stürzt vor Abschluss der Operation ab.
4. Kubernetes benötigt das Volume später nicht mehr.
5. Der neu gestartete Controller findet weiterhin eine ACL für Node A.

Die ACL beweist lediglich eine technische Berechtigung. Sie beweist nicht, dass Kubernetes diese Berechtigung weiterhin benötigt.

Damit entstehen zwei gefährliche Fehlentscheidungen:

- **ACL behalten:** Das Volume bleibt möglicherweise dauerhaft blockiert.
- **ACL entfernen:** Ein tatsächlich noch verwendetes Volume verliert möglicherweise seinen Zugriff.

Eine zusätzliche Storage-Authority oder ein zweiter Lock-Manager beseitigt dieses logische Problem nicht automatisch. Auch diese Instanz benötigt eine eindeutige Zustandsquelle und eine zuverlässige Recovery-Strategie.

Ein einzelner CSI-Controller vereinfacht die Koordination, garantiert aber bei aggressiver Pod-Beseitigung oder Netzwerkpartitionen noch keine absolute Einzigartigkeit.

## 6. Vorläufige Architekturentscheidung

### Option 1 als Ausgangsbasis

Kubernetes übernimmt die Attach-/Detach-Koordination. Unser CSI-Treiber implementiert die erforderlichen CSI-Operationen und meldet deren tatsächliches Ergebnis.

### Option 2 bleibt experimentell

Eine zusätzliche LIO-ACL-basierte Exklusivität wird erst produktiv aktiviert, wenn Koordination, Fehlerbehandlung und Wiederherstellung nachweislich zuverlässig funktionieren.

Auch Option 1 benötigt korrekte Storage-Operationen, insbesondere die Vermeidung unzulässiger gleichzeitiger Zuweisungen. Sie bedeutet nicht, dass `ControllerPublishVolume` ungeprüft Erfolg melden darf.

## 7. Offene Fragen vor der Implementierung

| Frage | Warum relevant? |
|---|---|
| Wiederholt k3s Publish nach einem Controller-Neustart? | Wiederherstellung unterbrochener Attach-Vorgänge |
| Wiederholt k3s Unpublish nach einem Absturz? | Vermeidung verwaister Freigaben |
| Was geschieht mit `VolumeAttachment` bei einem Controller-Ausfall? | Feststellung des maßgeblichen Sollzustands |
| Wie behandelt k3s erzwungene Detaches? | Sicherheit bei Node-Ausfällen |
| Welche Garantien gelten bei einem Controller-Neustart während einer laufenden Operation? | Vermeidung unvollständiger Zustandsübergänge |

Diese Fragen sollten anhand der tatsächlichen Kubernetes-/k3s-Implementierung und gezielter Fehlertests geklärt werden. Die Antworten sind bislang nicht nachgewiesen.

## 8. Schlussfolgerung

**Die wichtigste Erkenntnis ist, dass eine zusätzliche Sperre nur dann ein Sicherheitsgewinn ist, wenn sie zuverlässig wieder aufgehoben werden kann.**

Ein Lock-Mechanismus, der im Langzeitbetrieb nach und nach Volumes dauerhaft blockiert, ist keine akzeptable Lösung.

Deshalb gelten für die weitere Entwicklung folgende Leitlinien:

- Keine Nachimplementierung der Kubernetes-Pod- und Attach-/Detach-Steuerung im CSI.
- Keine zusätzlichen persistenten Locks ohne nachgewiesene Recovery.
- Keine automatische aggressive Übernahme fremder Volume-Zuweisungen.
- Keine pauschale Löschung von ACLs beim Controller-Neustart.
- Keine produktive Aktivierung der zusätzlichen LIO-Sperrlogik ohne erfolgreiche Fehlerfalltests.

**Nächster Arbeitsschritt:** Die tatsächlichen Wiederholungs- und Recovery-Mechanismen des k3s-Attach-/Detach-Controllers untersuchen. Erst danach entscheiden wir endgültig, ob und in welcher Form zusätzliche LIO-ACLs sinnvoll und betriebssicher sind.

Damit bleibt die Architektur zunächst bewusst einfach, ohne die ungelösten Fehlerfälle zu ignorieren.
