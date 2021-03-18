#!/bin/bash

set -e
#set -x

######## LINKS ########
# https://www.truenas.com/community/threads/moving-zfs-dataset-into-an-other.17720/
# https://www.truenas.com/community/threads/moving-a-zvol.76574/
# https://github.com/kubernetes/kubernetes/issues/77086

######## REQUIRMENTS #########
# kubectl
# curl
# jq

######### NOTES ############
# This script is meant to be downloaded and modified to your specific needs.
# The process is relatively intricate and the matrix of various options is
# quite large.
#
# It is highly recommended to create a test PV/PVC with the old provisioner to
# use as a playground to ensure you have things configured correctly and that
# the transition is smooth.
#
# From a high level the intent of this script is to:
# - update *existing* PVs/PVCs created with the non-csi provisioners to be managed by democratic-csi
# - ultimately after all PVs/PVCs have been migrated remove the non-csi provisioners from your cluster(s)
#
# To achieve the above goals the following happens:
# - each execution of the script is meant to migrate 1 PV/PVC to democratic-csi
# - original PV/PVC api object data is stored in ${PWD/tmp/*.json
# - PVC api object is deleted and recreated with proper values
# - PV api object is deleted and recreated with proper values
# - you will be required to `zfs rename` your old zfs zvols/dataset to place in the new democratic-csi structure
# - you will run several `curl` commands to update various share assets in TrueNAS via the API
# - you will run several `zfs` commands to set zfs properties on the datasets
# - you will be required to *stop* individual workloads using the volumes for a short period of time while migrating each PV/PVC
# - you should incure no data loss, after migration workloads should come up in exactly the same state they were before migration
#
# Several assumptions are made in this script
# - your intent is to use the *same* pool you used previously
# - you have already created/deployed democratic-csi
# - you have already deployed freenas-{nfs,iscsi}-provisioner(s)
# - you have direct access to the storage nas to run zfs commands
# - you can execute curl commands to manipulate shares/etc with the freenas api
# - where you execute the script should be setup with administrative kubectl/KUBECONFIG access

# currently only support v2 api so unused
# API_VERSION=2
FREENAS_USERNAME="root"
FREENAS_PASSWORD="secret"
FREENAS_URI="http://<ip>:port"

# where your pools get mounted
POOL_MNT_DIR="/mnt"

## nfs

#SHARE_STRATEGY="nfs" # hard-coded if migrating nfs-based volumes
#OLD_STORAGE_CLASS_NAME="freenas-nfs"
#NEW_STORAGE_CLASS_NAME="zfs-nfs"
#NEW_PARENT_DATASET="" # datasetParentName option from democratic-csi config
#PROVISIONER_IDENTITY="" # find this by looking at a PV created by the new storage class .spec.csi.volumeAttributes."storage.kubernetes.io/csiProvisionerIdentity"
#PROVISIONER_DRIVER="freenas-nfs"
#PROVISIONER_INSTANCE_ID="" # optional, should match the driver.instance_id attribute in your democratic-csi config

# should be the mountpoint, not the zfs path to the dataset
# zfs create tank/tmpnfs
# zfs destroy -r tank/tmpnfs
#TMP_ASSET="/mnt/tank/tmpnfs"

## end nfs

## iscsi

#SHARE_STRATEGY="iscsi" # hard-coded if migrating iscsi-based volumes
#OLD_STORAGE_CLASS_NAME="freenas-iscsi"
#NEW_STORAGE_CLASS_NAME="zfs-iscsi"
#NEW_PARENT_DATASET="" # datasetParentName option from democratic-csi config
#PROVISIONER_IDENTITY="" # find this by looking at a PV created by the new storage class .spec.csi.volumeAttributes."storage.kubernetes.io/csiProvisionerIdentity"
#PROVISIONER_DRIVER="freenas-iscsi"
#PROVISIONER_INSTANCE_ID="" # optional, should match the driver.instance_id attribute in your democratic-csi config

# should be the path to the zfs asset *not* a mountpath
# zfs create -V 1MB tank/tmpiscsi
# zfs destroy -r tank/tmpiscsi
#TMP_ASSET="tank/tmpiscsi"

# should match your iscsi.namePrefix/nameSuffix/template syntax in the democratic-csi config
# %s is replaced by the pvc-<id> string
#ISCSI_ASSET_NAME_TEMPLATE="csi.%s.primary"

## end iscsi

###### make sure you uncomment appropriate variable above in either the nfs or
###### iscsi block (just pick one of the blocks at a time), every thing below
###### here is script logic and should not need to be tampered with unless
###### special circumstances/configuration requires it

# get secret details
nscJSON=$(kubectl get sc "${NEW_STORAGE_CLASS_NAME}" -o json)
CONTROLLER_NAMESPACE=$(echo "${nscJSON}" | jq -crM '.parameters."csi.storage.k8s.io/controller-expand-secret-namespace"')

CE_SECRET_NAME=$(echo "${nscJSON}" | jq -crM '.parameters."csi.storage.k8s.io/controller-expand-secret-name"')
CP_SECRET_NAME=$(echo "${nscJSON}" | jq -crM '.parameters."csi.storage.k8s.io/controller-publish-secret-name"')
NP_SECRET_NAME=$(echo "${nscJSON}" | jq -crM '.parameters."csi.storage.k8s.io/node-publish-secret-name"')
NS_SECRET_NAME=$(echo "${nscJSON}" | jq -crM '.parameters."csi.storage.k8s.io/node-stage-secret-name"')
NEW_CSI_DRIVER_NAME=$(echo "${nscJSON}" | jq -crM ".provisioner")

function yes_or_no {
	while true; do
		read -p "$* [y/n]: " yn
		case $yn in
		[Yy]*) return 0 ;;
		[Nn]*)
			echo "Aborted"
			return 1
			;;
		esac
	done
}

for ipv in $(kubectl get pv -o json | jq -crM ".items[] | select(.spec.storageClassName|test(\"${OLD_STORAGE_CLASS_NAME}\")) | (.metadata.name,.spec.claimRef.namespace,.spec.claimRef.name)"); do
	:
	echo "${ipv}"
done

read -p "Which PV would you like to migrate? " TO_UPDATE

export pv="${TO_UPDATE}"

echo "migrating ${pv} to new provisioner"

# create temporary directory to store all original PV and PVC json
mkdir -p tmp

if [[ ! -f "tmp/${pv}-pv.json" ]]; then
	pvJSON=$(kubectl get pv "${pv}" -o json)
	echo "${pvJSON}" >>"tmp/${pv}-pv.json"
else
	pvJSON=$(cat "tmp/${pv}-pv.json")
fi

npvJSON="${pvJSON}"

name=$(echo "${pvJSON}" | jq -crM ".metadata.name")
status=$(echo "${pvJSON}" | jq -crM ".status.phase")
reclaimPolicy=$(echo "${pvJSON}" | jq -crM ".spec.persistentVolumeReclaimPolicy")

if [[ ${SHARE_STRATEGY} == "nfs" ]]; then
	:
	pool=$(echo "${pvJSON}" | jq -crM ".metadata.annotations.pool")
	dataset=$(echo "${pvJSON}" | jq -crM ".metadata.annotations.dataset")
	shareId=$(echo "${pvJSON}" | jq -crM ".metadata.annotations.shareId")
	server=$(echo "${pvJSON}" | jq -crM ".spec.nfs.server")
	path=$(echo "${pvJSON}" | jq -crM ".spec.nfs.path")
	fsType="nfs"
	npath="${POOL_MNT_DIR}/${NEW_PARENT_DATASET}/${pv}"

	# only need to remove these from the new json
	for annotation in shareId dataset datasetEnableQuotas datasetEnableReservation datasetParent datasetPreExisted freenasNFSProvisionerIdentity pool sharePreExisted; do
		:
		echo "removing annotation: ${annotation}"
		npvJSON=$(echo "${npvJSON}" | jq "del(.metadata.annotations.${annotation})")
	done

	npvJSON=$(echo "${npvJSON}" | jq ".spec.csi.volumeAttributes.server = \"${server}\"")
	npvJSON=$(echo "${npvJSON}" | jq ".spec.csi.volumeAttributes.share = \"${npath}\"")

	src="${dataset}"
fi

if [[ ${SHARE_STRATEGY} == "iscsi" ]]; then
	:
	pool=$(echo "${pvJSON}" | jq -crM ".metadata.annotations.pool")
	zvol=$(echo "${pvJSON}" | jq -crM ".metadata.annotations.zvol")
	targetId=$(echo "${pvJSON}" | jq -crM ".metadata.annotations.targetId")
	extentId=$(echo "${pvJSON}" | jq -crM ".metadata.annotations.extentId")
	targetGroupId=$(echo "${pvJSON}" | jq -crM ".metadata.annotations.targetGroupId")
	targetToExtentId=$(echo "${pvJSON}" | jq -crM ".metadata.annotations.targetToExtentId")
	zvol=$(echo "${pvJSON}" | jq -crM ".metadata.annotations.zvol")
	fsType=$(echo "${pvJSON}" | jq -crM ".spec.iscsi.fsType")
	lun=$(echo "${pvJSON}" | jq -crM ".spec.iscsi.lun")
	iqn=$(echo "${pvJSON}" | jq -crM ".spec.iscsi.iqn")
	targetPortal=$(echo "${pvJSON}" | jq -crM ".spec.iscsi.targetPortal")

	# only need to remove these from the new json
	for annotation in datasetParent extentId freenasISCSIProvisionerIdentity iscsiName pool targetGroupId targetId targetToExtentId zvol; do
		:
		echo "removing annotation: ${annotation}"
		npvJSON=$(echo "${npvJSON}" | jq "del(.metadata.annotations.${annotation})")
	done

	ISCSI_BASE_NAME="$(echo "${iqn}" | cut -d ":" -f1)"
	ISCSI_ASSET_NAME=$(printf "${ISCSI_ASSET_NAME_TEMPLATE}" "${pv}")
	niqn="${ISCSI_BASE_NAME}:${ISCSI_ASSET_NAME}"

	npvJSON=$(echo "${npvJSON}" | jq '.spec.csi.volumeAttributes.interface = ""')
	npvJSON=$(echo "${npvJSON}" | jq ".spec.csi.volumeAttributes.iqn = \"${niqn}\"")
	npvJSON=$(echo "${npvJSON}" | jq ".spec.csi.volumeAttributes.lun = \"${lun}\"")
	npvJSON=$(echo "${npvJSON}" | jq ".spec.csi.volumeAttributes.portal = \"${targetPortal}\"")
	npvJSON=$(echo "${npvJSON}" | jq '.spec.csi.volumeAttributes.portals = ""')

	src="${pool}/${zvol}"
fi

dst="${NEW_PARENT_DATASET}/${name}"

npvJSON=$(echo "${npvJSON}" | jq ".metadata.annotations.\"pv.kubernetes.io/provisioned-by\" = \"${NEW_CSI_DRIVER_NAME}\"")

# remove old, update old
npvJSON=$(echo "${npvJSON}" | jq "del(.metadata.resourceVersion)")
npvJSON=$(echo "${npvJSON}" | jq "del(.spec.nfs)")
npvJSON=$(echo "${npvJSON}" | jq "del(.spec.iscsi)")
npvJSON=$(echo "${npvJSON}" | jq ".spec.storageClassName = \"${NEW_STORAGE_CLASS_NAME}\"")
npvJSON=$(echo "${npvJSON}" | jq ".spec.csi.driver = \"${NEW_CSI_DRIVER_NAME}\"")
npvJSON=$(echo "${npvJSON}" | jq ".spec.csi.volumeHandle = \"${name}\"")
npvJSON=$(echo "${npvJSON}" | jq ".spec.csi.fsType = \"${fsType}\"")
npvJSON=$(echo "${npvJSON}" | jq '.spec.persistentVolumeReclaimPolicy = "Retain"')

# secrets
npvJSON=$(echo "${npvJSON}" | jq ".spec.csi.controllerExpandSecretRef.name = \"${CE_SECRET_NAME}\"")
npvJSON=$(echo "${npvJSON}" | jq ".spec.csi.controllerExpandSecretRef.namespace = \"${CONTROLLER_NAMESPACE}\"")
npvJSON=$(echo "${npvJSON}" | jq ".spec.csi.controllerPublishSecretRef.name = \"${CP_SECRET_NAME}\"")
npvJSON=$(echo "${npvJSON}" | jq ".spec.csi.controllerPublishSecretRef.namespace = \"${CONTROLLER_NAMESPACE}\"")
npvJSON=$(echo "${npvJSON}" | jq ".spec.csi.nodePublishSecretRef.name = \"${NP_SECRET_NAME}\"")
npvJSON=$(echo "${npvJSON}" | jq ".spec.csi.nodePublishSecretRef.namespace = \"${CONTROLLER_NAMESPACE}\"")
npvJSON=$(echo "${npvJSON}" | jq ".spec.csi.nodeStageSecretRef.name = \"${NS_SECRET_NAME}\"")
npvJSON=$(echo "${npvJSON}" | jq ".spec.csi.nodeStageSecretRef.namespace = \"${CONTROLLER_NAMESPACE}\"")

npvJSON=$(echo "${npvJSON}" | jq ".spec.csi.volumeAttributes.node_attach_driver = \"${SHARE_STRATEGY}\"")
npvJSON=$(echo "${npvJSON}" | jq ".spec.csi.volumeAttributes.provisioner_driver = \"${PROVISIONER_DRIVER}\"")
npvJSON=$(echo "${npvJSON}" | jq ".spec.csi.volumeAttributes.\"storage.kubernetes.io/csiProvisionerIdentity\" = \"${PROVISIONER_IDENTITY}\"")

if [[ ${status} == "Bound" ]]; then
	:
	# ensure any workloads are shutdown
	yes_or_no "Please type y when all workloads using the PV/PVC have been scaled to 0"
	yes_or_no "Are you certain nothing is using the share?"

	claimName=$(echo "${pvJSON}" | jq -crM ".spec.claimRef.name")
	claimNamespace=$(echo "${pvJSON}" | jq -crM ".spec.claimRef.namespace")

	echo "${claimNamespace}/${claimName}"

	if [[ ! -f "tmp/${pv}-pvc.json" ]]; then
		pvcJSON=$(kubectl -n "${claimNamespace}" get pvc "${claimName}" -o json)
		echo "${pvcJSON}" >>"tmp/${pv}-pvc.json"
	else
		pvcJSON=$(cat "tmp/${pv}-pvc.json")
	fi

	npvcJSON="${pvcJSON}"

	kubectl patch pv "${name}" -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
	kubectl -n "${claimNamespace}" delete pvc "${claimName}" --wait=false || true
	sleep 3
	kubectl -n "${claimNamespace}" patch pvc "${claimName}" -p '{"metadata":{"finalizers": null }}' || true
	sleep 3

	# update pvc
	npvcJSON=$(echo "${npvcJSON}" | jq "del(.metadata.resourceVersion)")
	npvcJSON=$(echo "${npvcJSON}" | jq ".metadata.annotations.\"volume.beta.kubernetes.io/storage-provisioner\" = \"${NEW_CSI_DRIVER_NAME}\"")
	npvcJSON=$(echo "${npvcJSON}" | jq ".spec.storageClassName = \"${NEW_STORAGE_CLASS_NAME}\"")

	# recreate pvc
	echo "${npvcJSON}" | jq .
	yes_or_no "Would you like to contiue with the update to the PVC with the above details? "
	echo "${npvcJSON}" | kubectl apply -f -

	# get pvc .metadata.uid
	uid=$(kubectl -n "${claimNamespace}" get pvc "${claimName}" -o jsonpath='{.metadata.uid}')

	# set pv .spec.claimRef.uid
	#npvJSON="${pvJSON}"
	npvJSON=$(echo "${npvJSON}" | jq "del(.metadata.resourceVersion)")
	npvJSON=$(echo "${npvJSON}" | jq ".spec.claimRef.uid = \"${uid}\"")

	# wait for things to settle and all should be well
	sleep 3
fi

if [[ ${status} == "Released" ]]; then
	yes_or_no "PV status is Released, not updating PVC details, is this OK?"
fi

echo "${npvJSON}" | jq .
yes_or_no "Would you like to contiue with the update to the PV with the above details? " && {
	:
	echo "starting PV update PV ${pv}"
	kubectl patch pv "${name}" -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
	kubectl delete pv "${name}"
	echo "${npvJSON}" | kubectl apply -f -
	echo "successfully updated PV ${pv}"
} || {
	:
	echo "you decided no"
}

if [[ -z ${src} || ${src} == "null" || ${src} == "null" ]]; then
	read -p "Prompt for src zvol/dataset  (share path: ${path}): " src
fi

if [[ ${SHARE_STRATEGY} == "nfs" ]]; then
	if [[ -z ${shareId} || ${shareId} == "null" ]]; then
		echo "Edit the share in the FreeNAS UI and observe the id in the URL address bar"
		read -p "shareId: " shareId
	fi
fi

echo ""
echo ""
yes_or_no "Do you understand that you *must* execute all the commands shown after this message in the *exact* order shown? You cannot skip any of them, they all must succeed (including 200s from the curl commands)." && {
	echo "OK then, moving on :)"
} || {
	echo "It's best you stop here"
	exit 1
}
echo ""
echo ""

echo "################## commands to run on TrueNAS cli #############################"
echo ""
echo "# set properties"

# common
if [[ -n ${PROVISIONER_INSTANCE_ID} ]]; then
	echo "zfs set democratic-csi:volume_context_provisioner_instance_id=${PROVISIONER_INSTANCE_ID} ${src}"
fi

echo "zfs set democratic-csi:csi_volume_name=${pv} ${src}"
echo "zfs set democratic-csi:provision_success=true ${src}"
echo "zfs set democratic-csi:managed_resource=true ${src}"

if [[ ${SHARE_STRATEGY} == "nfs" ]]; then
	# nfs
	volume_context="{\"node_attach_driver\":\"nfs\",\"server\":\"${server}\",\"share\":\"${npath}\"}"
	echo "zfs set democratic-csi:csi_share_volume_context='${volume_context}' ${src}"
	echo "zfs set democratic-csi:freenas_nfs_share_id=${shareId} ${src}"
	echo "zfs set democratic-csi:volume_context_provisioner_driver=freenas-nfs ${src}"
fi

if [[ ${SHARE_STRATEGY} == "iscsi" ]]; then
	# iscsi
	echo "zfs set democratic-csi:freenas_iscsi_assets_name=${ISCSI_ASSET_NAME} ${src}"
	volume_context="{\"node_attach_driver\":\"iscsi\",\"portal\":\"${targetPortal}\",\"portals\":\"\",\"interface\":\"\",\"iqn\":\"${niqn}\",\"lun\":${lun}}"
	echo "zfs set democratic-csi:csi_share_volume_context='${volume_context}' ${src}"
	echo "zfs set democratic-csi:freenas_iscsi_target_id=${targetId} ${src}"
	echo "zfs set democratic-csi:freenas_iscsi_extent_id=${extentId} ${src}"
	echo "zfs set democratic-csi:freenas_iscsi_targettoextent_id=${targetToExtentId} ${src}"
	echo "zfs set democratic-csi:volume_context_provisioner_driver=freenas-iscsi ${src}"

fi

echo ""
echo ""
echo "################## end commands to run on FreeNAS cli #############################"

echo ""
echo "#################### API curl command to update share #########################"
echo ""

# update shares to point to new location of vol/dataset
# rename dataset/zvol
if [[ ${SHARE_STRATEGY} == "nfs" ]]; then
	# nfs
	:
	echo "# temporarily assign share to different path to free up dataset for rename"
	echo "curl -v -u\"${FREENAS_USERNAME}:${FREENAS_PASSWORD}\" -H \"Content-Type: application/json\" -H \"Accept: application/json\" -XPUT \"${FREENAS_URI}/api/v2.0/sharing/nfs/id/${shareId}\" -d '{\"paths\":[\"${TMP_ASSET}\"]}'"

	echo ""
	echo "# rename asset"
	echo "zfs rename -p -f ${src} ${dst}"
	echo ""

	echo "# re-associate the share with the dataset"
	echo "curl -v -u\"${FREENAS_USERNAME}:${FREENAS_PASSWORD}\" -H \"Content-Type: application/json\" -H \"Accept: application/json\" -XPUT \"${FREENAS_URI}/api/v2.0/sharing/nfs/id/${shareId}\" -d '{\"paths\":[\"${npath}\"]}'"
fi

if [[ ${SHARE_STRATEGY} == "iscsi" ]]; then
	# iscsi
	:
	echo "# temporarily assign extent to different asset to free up zvol for rename"
	echo "curl -v -u\"${FREENAS_USERNAME}:${FREENAS_PASSWORD}\" -H \"Content-Type: application/json\" -H \"Accept: application/json\" -XPUT \"${FREENAS_URI}/api/v2.0/iscsi/extent/id/${extentId}\" -d '{\"path\":\"zvol/${TMP_ASSET}\", \"disk\":\"zvol/${TMP_ASSET}\"}'"

	echo ""
	echo "# rename asset"
	echo "zfs rename -p -f ${src} ${dst}"
	echo ""

	echo "curl -v -u\"${FREENAS_USERNAME}:${FREENAS_PASSWORD}\" -H \"Content-Type: application/json\" -H \"Accept: application/json\" -XPUT \"${FREENAS_URI}/api/v2.0/iscsi/target/id/${targetId}\" -d '{\"name\":\"${ISCSI_ASSET_NAME}\"}'"
	echo "curl -v -u\"${FREENAS_USERNAME}:${FREENAS_PASSWORD}\" -H \"Content-Type: application/json\" -H \"Accept: application/json\" -XPUT \"${FREENAS_URI}/api/v2.0/iscsi/extent/id/${extentId}\" -d '{\"name\":\"${ISCSI_ASSET_NAME}\", \"path\":\"zvol/${dst}\", \"disk\":\"zvol/${dst}\"}'"
fi

echo ""
echo "################## end API curl command to update share #############################"

echo "################## final cleanup ######################"
echo ""
echo "# ensure volumes are bound/etc as appropriate and restart your workloads here and ensure all is well"
echo ""
echo "# restore original reclaim policy"
echo "kubectl patch pv \"${name}\" -p '{\"spec\":{\"persistentVolumeReclaimPolicy\":\"${reclaimPolicy}\"}}'"
echo ""
echo "################## end final cleanup ######################"
