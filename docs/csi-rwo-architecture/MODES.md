# CSI iSCSI Controller-Publish-Modi (Implementierungsstand Modus 2)

Stand: 22.11.2026. Implementiert für `zfs-generic-iscsi` in `src/driver/controller-zfs/index.js`.

## Konfiguration

Unter `iscsi`:

```yaml
iscsi:
  controllerPublishMode: 1
```

- **0:** Legacy-Modus. `PUBLISH_UNPUBLISH_VOLUME` wird nicht angeboten; Publish/Unpublish sind deaktiviert.
- **1 (Standard):** CSI `ControllerPublishVolume` und `ControllerUnpublishVolume` werden angeboten. Kubernetes koordiniert die Attach-/Detach-Anforderungen. Keine Initiator-ACLs, keine Locks, kein eigener Besitzstand.
- **2:** Persistente Node-Exklusivität. Pro ZVOL wird die ZFS-User-Property `democratic-csi:publish_owner` gespeichert. Ein anderer Node erhält `FAILED_PRECONDITION`; derselbe Node darf idempotent erneut publishen. Unpublish entfernt die Property. Gleichzeitige Controller-Anfragen werden durch ein kurzlebiges `flock` auf dem ZFS-Host serialisiert. Die Sperrdatei ist **nicht** der persistente Besitzerzustand.\n\n**Pod-Exklusivität:** `ControllerPublishVolume` erhält `node_id`, aber keine zuverlässige `pod_id`. Mehrere Pods auf demselben Node sind daher in Modus 2 zulässig. Für Pod-Exklusivität Kubernetes `ReadWriteOncePod` (RWOP) verwenden; ein Modus 3 wird bewusst nicht implementiert.\n\n**Betrieb und Grenzen von Modus 2:** Der Eigentümer bleibt nach Controller-Neustart und Node-Ausfall bestehen; es gibt keine automatische Timeout-Freigabe. Ein fehlender `node_id` bei `ControllerUnpublishVolume` ist CSI-konform und gibt den vorhandenen Besitzer frei. Eine solche Freigabe ist nur sicher, wenn Kubernetes den vorherigen Mount tatsächlich abgebaut hat. Ein abweichender, explizit angegebener Node wird abgewiesen. Keine Initiator-ACLs, kein Storage-Fencing: Bereits bestehende iSCSI-Sessions werden nicht durch eine Controller-Ablehnung beendet. Die Property verhindert nur konkurrierende CSI-ControllerPublish-Zuweisungen. Der Host benötigt `flock` und Schreibrechte auf `/run` und ZFS.

Modus 1: Publish prüft Pflichtfelder und die Existenz des ZFS-Datasets, gibt dann einen leeren `publish_context` zurück. Unpublish ist idempotent und gibt Erfolg zurück, auch wenn das Dataset bereits gelöscht wurde. Es erfolgen **keine** LIO-Konfigurationsänderungen bei Publish/Unpublish. Die iSCSI-Target-/LUN-Erstellung bleibt Aufgabe des bestehenden CreateVolume-Pfads; Login/Mount erfolgen auf dem Node.

**Sicherheitsgrenze:** Modus 1 bietet keine storage-seitige RWO-Exklusivität und kein Fencing. Ein bereits verbundener Initiator wird durch Unpublish nicht getrennt. Der Modus dient dem ersten Ende-zu-Ende-Test von CSI, ZFS-ZVOL und iSCSI und setzt ein geeignet isoliertes Testnetz voraus.

## Teststatus und offene Tests

1. Installation des aktualisierten Controllers mit Modus 1 und dessen gemeldete CSI-Capabilities.
2. Dynamisches Provisionieren eines neuen ZVOLs und erfolgreicher Pod-Mount mit Lese-/Schreibzugriff.
3. Wiederholung von Publish/Unpublish und Controller-Neustart; CSI-Ablauf und Kubernetes VolumeAttachment beobachten.
4. Node-Wechsel und Fehlerfälle beobachten, **bevor** ein persistenter Besitzerzustand (Modus 2) konzipiert wird.

## Bekannte LIO-Fehlerdiagnose

Beim manuellen FileIO-Test war die LUN lesbar, aber zunächst nicht beschreibbar. Nach Umstellung auf eine explizite Initiator-ACL mit `mapped_lun0 ... (rw)` und erneutem iSCSI-Login gelang der Schreibtest. Die einzelne Ursache wurde damals nicht isoliert. Das ist **keine** Voraussetzung für Modus 1 und kein Beleg dafür, dass automatische LIO-ACLs grundsätzlich nur Lesen erlauben. LIO-Installation und allgemeine Fehlerbehebung verbleiben beim Storage-Administrator.
