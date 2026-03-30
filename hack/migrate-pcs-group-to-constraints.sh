#!/usr/bin/env bash
#
# migrate-pcs-group-to-constraints.sh
#
# Migrates iSCSI target/LUN Pacemaker resources from group membership to
# standalone resources with colocation and ordering constraints.
#
# This eliminates cascading stop/restart of all iSCSI resources when any
# single resource is added or removed, and enables parallel failover.
#
# See: https://github.com/democratic-csi/democratic-csi/issues/547
#
# Usage:
#   ./migrate-pcs-group-to-constraints.sh [options]
#
# Options:
#   --group NAME     Pacemaker group name (default: group-nas)
#   --sudo           Use sudo for pcs commands
#   --dry-run        Show what would be done without making changes
#   --help           Show this help message
#
# The script is idempotent — safe to run multiple times.
# Run on the NAS host where Pacemaker is running, or via SSH.

set -euo pipefail

GROUP="group-nas"
SUDO=""
DRY_RUN=false

usage() {
  sed -n '2,/^$/s/^# \?//p' "$0"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --group)   GROUP="$2"; shift 2 ;;
    --sudo)    SUDO="sudo"; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help)    usage ;;
    *)         echo "Unknown option: $1"; usage ;;
  esac
done

pcs_cmd() {
  if $DRY_RUN; then
    echo "[dry-run] $SUDO pcs $*"
    return 0
  fi
  $SUDO pcs "$@"
}

log() { echo "==> $*"; }
warn() { echo "WARNING: $*" >&2; }

# --- Discover current group members ---

log "Reading group '$GROUP' membership..."
GROUP_MEMBERS=$($SUDO pcs resource group list 2>/dev/null \
  | grep "^${GROUP}:" \
  | sed "s/^${GROUP}: //" \
  | tr ' ' '\n')

if [[ -z "$GROUP_MEMBERS" ]]; then
  echo "Group '$GROUP' not found or empty. Nothing to migrate."
  exit 0
fi

# Separate anchor resources (stay in group) from iSCSI resources (migrate out)
ANCHORS=()
TARGETS=()
LUNS=()
ORPHAN_TARGETS=()

while IFS= read -r res; do
  case "$res" in
    target-pvc-*) TARGETS+=("$res") ;;
    lun-pvc-*)    LUNS+=("$res") ;;
    *)            ANCHORS+=("$res") ;;
  esac
done <<< "$GROUP_MEMBERS"

echo ""
echo "Group '$GROUP' contains:"
echo "  Anchors (stay in group): ${ANCHORS[*]:-none}"
echo "  iSCSI targets to migrate: ${#TARGETS[@]}"
echo "  iSCSI LUNs to migrate: ${#LUNS[@]}"

# Build a set of PVC IDs that have LUNs for orphan detection
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

# --- Phase 1: Add constraints (while resources are still in the group) ---
# This is non-disruptive: resources satisfy both group and constraint rules.

log "Phase 1: Adding colocation and ordering constraints..."

for target in "${TARGETS[@]}"; do
  pvc_id="${target#target-}"

  # Colocate target with the group anchor (same node)
  log "  colocation: $target with $GROUP"
  pcs_cmd constraint colocation add "$target" with "$GROUP" INFINITY 2>/dev/null || true

  # Order: group must be running before target starts
  log "  ordering:   $GROUP then $target"
  pcs_cmd constraint order "$GROUP" then "$target" 2>/dev/null || true
done

for lun in "${LUNS[@]}"; do
  pvc_id="${lun#lun-}"
  target="target-${pvc_id}"

  # Colocate LUN with its target
  log "  colocation: $lun with $target"
  pcs_cmd constraint colocation add "$lun" with "$target" INFINITY 2>/dev/null || true

  # Order: target must be running before LUN starts
  log "  ordering:   $target then $lun"
  pcs_cmd constraint order "$target" then "$lun" 2>/dev/null || true
done

echo ""

# --- Phase 2: Remove iSCSI resources from the group ---
# Resources become standalone but keep running (non-disruptive).
# Constraints from Phase 1 ensure they stay on the correct node.
# We remove in reverse group order (last first) to minimize recalculations.

log "Phase 2: Removing iSCSI resources from group '$GROUP'..."

# Build reverse-ordered list of resources to remove
REMOVE_LIST=()
for res in "${TARGETS[@]}" "${LUNS[@]}"; do
  REMOVE_LIST+=("$res")
done

# Remove in reverse order
for (( i=${#REMOVE_LIST[@]}-1; i>=0; i-- )); do
  res="${REMOVE_LIST[$i]}"
  log "  removing: $res"
  pcs_cmd resource group remove "$GROUP" "$res" 2>/dev/null || true
done

echo ""

# --- Phase 3: Report results ---

log "Phase 3: Verifying..."

if ! $DRY_RUN; then
  REMAINING=$($SUDO pcs resource group list 2>/dev/null \
    | grep "^${GROUP}:" \
    | sed "s/^${GROUP}: //")
  echo ""
  echo "Group '$GROUP' now contains: $REMAINING"
  echo ""

  CONSTRAINT_COUNT=$($SUDO pcs constraint colocation 2>/dev/null \
    | grep -c "target-pvc-\|lun-pvc-" || true)
  echo "Colocation constraints for iSCSI resources: $CONSTRAINT_COUNT"

  ORDER_COUNT=$($SUDO pcs constraint order 2>/dev/null \
    | grep -c "target-pvc-\|lun-pvc-" || true)
  echo "Ordering constraints for iSCSI resources: $ORDER_COUNT"
fi

echo ""
log "Migration complete."

if [[ ${#ORPHAN_TARGETS[@]} -gt 0 ]]; then
  echo ""
  warn "Orphaned targets (no matching LUN) were migrated but may need manual cleanup:"
  for t in "${ORPHAN_TARGETS[@]}"; do
    echo "  $SUDO pcs resource delete $t"
  done
fi

echo ""
echo "Next steps:"
echo "  1. Verify all iSCSI sessions are healthy: iscsiadm -m session"
echo "  2. Check resource status: $SUDO pcs status resources"
echo "  3. Test failover in a maintenance window"
