#!/bin/bash

######## REQUIRMENTS #########
# kubectl
# yq (https://github.com/mikefarah/yq)
# a valid EDITOR env variable set

set -e
#set -x

function yes_or_no {
	while true; do
		read -p "$* [y/n]: " yn
		case $yn in
		[Yy]*) return 0 ;;
		[Nn]*)
			return 1
			;;
		esac
	done
}

PV=${1}

if [[ -z ${PV} ]]; then
	echo "must supply a PV name"
	exit 1
fi

PV_ORIG_FILE="/tmp/${PV}-orig.yaml"
PV_TMP_FILE="/tmp/${PV}-tmp.yaml"

# save original
if [[ -f ${PV_ORIG_FILE} ]]; then
	yes_or_no "It appears we already made a backup of ${PV}. Would you like to use the existing backup? (if no, a fresh backup will be created)" && {
		:
	} || {
		rm "${PV_ORIG_FILE}"
	}
fi

if [[ ! -f ${PV_ORIG_FILE} ]]; then
	kubectl get pv "${PV}" -o yaml >"${PV_ORIG_FILE}"
fi

reclaimPolicy=$(yq '.spec.persistentVolumeReclaimPolicy' "${PV_ORIG_FILE}")

# copy file for editing
cp "${PV_ORIG_FILE}" "${PV_TMP_FILE}"

# pre-process before edit
yq -i 'del(.metadata.resourceVersion)' "${PV_TMP_FILE}"

# manually edit
${EDITOR} "${PV_TMP_FILE}"

# ask if looks good
yq '.' "${PV_TMP_FILE}"
yes_or_no "Would you like to delete the existing PV object and recreate with the above data?"

# set relaim to Retain on PV
kubectl patch pv "${PV}" -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'

# delete PV from API
kubectl delete pv "${PV}" --wait=false
kubectl patch pv "${PV}" -p '{"metadata":{"finalizers": null }}' &>/dev/null || true

# re-apply newly updated file
kubectl apply -f "${PV_TMP_FILE}"

# restore original reclaim value
kubectl patch pv "${PV}" -p "{\"spec\":{\"persistentVolumeReclaimPolicy\":\"${reclaimPolicy}\"}}"

# spit out any zfs properties updates
yes_or_no "Would you like to delete the PV backup file?" && {
	rm "${PV_ORIG_FILE}"
} || {
	:
}

rm "${PV_TMP_FILE}"
echo "Edit complete!"
