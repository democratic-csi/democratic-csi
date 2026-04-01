#!/usr/bin/env bash
#
# migrate-pcs-group-to-constraints.sh
#
# Migrates iSCSI target/LUN Pacemaker resources from group membership to
# standalone resources with colocation and ordering constraints.
#
# Each target+LUN pair is migrated as an atomic CIB update via crm_shadow.
# If interrupted, re-run safely — already-migrated pairs are skipped.
#
# See: https://github.com/democratic-csi/democratic-csi/issues/547
#
# Usage:
#   ./migrate-pcs-group-to-constraints.sh [options]
#
# Options:
#   --group NAME     Pacemaker group name (default: group-nas)
#   --dry-run        Show what would be done without making changes
#   --help           Show this help message
#
# Must be run as root.

set -euo pipefail

GROUP="group-nas"
DRY_RUN=false

usage() {
  sed -n '2,/^$/s/^# \?//p' "$0"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --group)   GROUP="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help)    usage ;;
    *)         echo "Unknown option: $1"; usage ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "Error: this script must be run as root." >&2
  exit 1
fi

log() { echo "==> $*"; }
warn() { echo "WARNING: $*" >&2; }

# --- Discover current group members ---

log "Reading group '$GROUP' membership..."
GROUP_MEMBERS=$(pcs resource group list 2>/dev/null \
  | grep "^${GROUP}:" \
  | sed "s/^${GROUP}: //" \
  | tr ' ' '\n')

if [[ -z "$GROUP_MEMBERS" ]]; then
  echo "Group '$GROUP' not found or empty. Nothing to migrate."
  exit 0
fi

ANCHORS=()
TARGETS=()
LUNS=()
ORPHAN_TARGETS=()

while IFS= read -r res; do
  case "$res" in
    target-*) TARGETS+=("$res") ;;
    lun-*)    LUNS+=("$res") ;;
    *)        ANCHORS+=("$res") ;;
  esac
done <<< "$GROUP_MEMBERS"

echo ""
echo "Group '$GROUP' contains:"
echo "  Anchors (stay in group): ${ANCHORS[*]:-none}"
echo "  iSCSI targets to migrate: ${#TARGETS[@]}"
echo "  iSCSI LUNs to migrate: ${#LUNS[@]}"

declare -A LUN_PVCS
for lun in "${LUNS[@]}"; do
  pvc_id="${lun#lun-}"
  LUN_PVCS["$pvc_id"]=1
done

for target in "${TARGETS[@]}"; do
  pvc_id="${target#target-}"
  if [[ -z "${LUN_PVCS[$pvc_id]+x}" ]]; then
    ORPHAN_TARGETS+=("$target")
  fi
done

if [[ ${#ORPHAN_TARGETS[@]} -gt 0 ]]; then
  echo ""
  warn "Found ${#ORPHAN_TARGETS[@]} orphaned target(s) without matching LUN:"
  for t in "${ORPHAN_TARGETS[@]}"; do
    echo "    $t"
  done
fi

TOTAL=$((${#TARGETS[@]} + ${#LUNS[@]}))
if [[ $TOTAL -eq 0 ]]; then
  echo "No iSCSI resources to migrate."
  exit 0
fi

echo ""
if $DRY_RUN; then
  echo "--- DRY RUN MODE (no changes will be made) ---"
fi
echo ""

# --- Migrate each target+LUN pair atomically ---
# Iterate in reverse group order so each removal is at the tail of the
# group, avoiding cascading stop/restart of resources that follow it.

MIGRATED=0
FAILED=0

for (( i=${#TARGETS[@]}-1; i>=0; i-- )); do
  target="${TARGETS[$i]}"
  pvc_id="${target#target-}"
  lun="lun-${pvc_id}"
  has_lun="${LUN_PVCS[$pvc_id]+yes}"
  shadow_name="migrate-${pvc_id:0:20}-$$"

  if [[ -n "$has_lun" ]]; then
    log "Migrating pair ($((${#TARGETS[@]}-i))/${#TARGETS[@]}): $target + $lun"
  else
    log "Migrating orphan target ($((${#TARGETS[@]}-i))/${#TARGETS[@]}): $target"
  fi

  if $DRY_RUN; then
    echo "[dry-run] crm_shadow --create $shadow_name --batch --force"
    echo "[dry-run] export CIB_shadow=$shadow_name"
    if [[ -n "$has_lun" ]]; then
      echo "[dry-run] pcs resource group remove $GROUP $lun"
    fi
    echo "[dry-run] pcs resource group remove $GROUP $target"
    echo "[dry-run] pcs constraint colocation add $target with $GROUP INFINITY"
    echo "[dry-run] pcs constraint order $GROUP then $target"
    if [[ -n "$has_lun" ]]; then
      echo "[dry-run] pcs constraint colocation add $lun with $target INFINITY"
      echo "[dry-run] pcs constraint order $target then $lun"
    fi
    echo "[dry-run] crm_shadow --commit $shadow_name --force"
    echo ""
    MIGRATED=$((MIGRATED + 1))
    continue
  fi

  crm_shadow --create "$shadow_name" --batch --force 2>/dev/null
  export CIB_shadow="$shadow_name"

  if (
    if [[ -n "$has_lun" ]]; then
      pcs resource group remove "$GROUP" "$lun" 2>/dev/null || true
    fi

    pcs resource group remove "$GROUP" "$target" 2>/dev/null || true

    pcs constraint colocation add "$target" with "$GROUP" INFINITY 2>/dev/null || true
    pcs constraint order "$GROUP" then "$target" 2>/dev/null || true

    if [[ -n "$has_lun" ]]; then
      pcs constraint colocation add "$lun" with "$target" INFINITY 2>/dev/null || true
      pcs constraint order "$target" then "$lun" 2>/dev/null || true
    fi
  ); then
    crm_shadow --commit "$shadow_name" --force 2>/dev/null
    log "  committed"
    MIGRATED=$((MIGRATED + 1))
  else
    warn "  failed to prepare shadow for $target, skipping"
    FAILED=$((FAILED + 1))
  fi

  unset CIB_shadow
  crm_shadow --delete "$shadow_name" --force 2>/dev/null || true
  echo ""

  # let pacemaker settle before the next pair
  sleep 2
done

# --- Report results ---

echo ""
log "Migration complete: $MIGRATED migrated, $FAILED failed"

if ! $DRY_RUN; then
  echo ""
  REMAINING=$(pcs resource group list 2>/dev/null \
    | grep "^${GROUP}:" \
    | sed "s/^${GROUP}: //")
  echo "Group '$GROUP' now contains: $REMAINING"

  CONSTRAINT_COUNT=$(pcs constraint colocation 2>/dev/null \
    | grep -c "target-\|lun-" || true)
  echo "Colocation constraints for iSCSI resources: $CONSTRAINT_COUNT"

  ORDER_COUNT=$(pcs constraint order 2>/dev/null \
    | grep -c "target-\|lun-" || true)
  echo "Ordering constraints for iSCSI resources: $ORDER_COUNT"
fi

if [[ ${#ORPHAN_TARGETS[@]} -gt 0 ]]; then
  echo ""
  warn "Orphaned targets (no matching LUN) were migrated but may need manual cleanup:"
  for t in "${ORPHAN_TARGETS[@]}"; do
    echo "  pcs resource delete $t"
  done
fi

echo ""
echo "Next steps:"
echo "  1. Verify all iSCSI sessions are healthy: iscsiadm -m session"
echo "  2. Check resource status: pcs status resources"
echo "  3. Test failover in a maintenance window"
