![Image](https://img.shields.io/docker/pulls/democraticcsi/democratic-csi.svg)
![Image](https://img.shields.io/github/workflow/status/democratic-csi/democratic-csi/CI?style=flat-square)

# Introduction
## What is Democratic-CSI?  
`Democratic-CSI` implements the `csi` (Container Storage Interface) specifications providing storage for various container orchestration systems (*ie: Kubernetes, Nomad, OpenShift*).

The current *focus* is providing storage via iSCSI or NFS from ZFS-based storage systems, predominantly `TrueNAS / FreeNAS` and `ZoL on Ubuntu`.  
The current *drivers* implement the depth and breadth of the `csi` specifications, so you have access to resizing, snapshots, clones, etc functionality.

## What can Democratic-CSI offer? 
**Several implementations of `CSI` drivers**  
:arrow_forward: `freenas-nfs` (manages zfs datasets to share over nfs)  
:arrow_forward: `freenas-iscsi` (manages zfs zvols to share over iscsi)  
:arrow_forward: `freenas-smb` (manages zfs datasets to share over smb)  
:arrow_forward: `freenas-api-nfs` experimental use with SCALE only (manages zfs datasets to share over nfs)  
:arrow_forward: `freenas-api-iscsi` experimental use with SCALE only (manages zfs zvols to share over iscsi)  
:arrow_forward: `freenas-api-smb` experimental use with SCALE only (manages zfs datasets to share over smb)  
:arrow_forward: `zfs-generic-nfs` (works with any ZoL installation...ie: Ubuntu)  
:arrow_forward: `zfs-generic-iscsi` (works with any ZoL installation...ie: Ubuntu)  
:arrow_forward: `zfs-local-ephemeral-inline` (provisions node-local zfs datasets)  
:arrow_forward: `synology-iscsi` experimental (manages volumes to share over iscsi)  
:arrow_forward: `lustre-client` (crudely provisions storage using a shared lustre share/directory for all volumes)  
:arrow_forward: `nfs-client` (crudely provisions storage using a shared nfs share/directory for all volumes)  
:arrow_forward: `smb-client` (crudely provisions storage using a shared smb share/directory for all volumes)  
:arrow_forward: `node-manual` (allows connecting to manually created smb, nfs, lustre, and iscsi volumes, see sample PVs in the `examples` directory)  

**Development**  
:arrow_forward: Framework for developing `CSI` drivers

If you have any interest in providing a `CSI` driver, simply open an issue to
discuss. The project provides an extensive framework to build and making it
relatively easy to implement new drivers.

## Community Guides

[Using TrueNAS to provide persistent storage for Kubernetes](https://jonathangazeley.com/2021/01/05/using-truenas-to-provide-persistent-storage-for-kubernetes/)  
[Migrating from `NFS-client-provisioner` to `democratic-CSI`](https://gist.github.com/admun/4372899f20421a947b7544e5fc9f9117)  
[Migrating between storage classes using `Velero`](https://gist.github.com/deefdragon/d58a4210622ff64088bd62a5d8a4e8cc)

# Installation

Predominantly 3 prerequisites are needed:  
- Nodes preperation (ie: Kubernetes cluster nodes)
- Storage server preperation
- Deployment of the driver into the cluster (`helm` chart provided with sample
  `values.yaml`)


## **Node preperation**
Alright, you have chosen your driver. Let's start by configuring the prerequisites for your Node.  
You can choose to use either **NFS** or **iSCSI** or **both**.

### **NFS configuration** 
___ 
**RHEL / CentOS**   
```
sudo yum install -y nfs-utils
```

**Ubuntu / Debian**  
```
sudo apt-get install -y nfs-common
```
<br/>

### **iSCSI configuration**  
___ 
**RHEL / CentOS** 
Install the following system packages:
```
sudo yum install -y lsscsi iscsi-initiator-utils sg3_utils device-mapper-multipath
```
Enable multipathing:
```
sudo mpathconf --enable --with_multipathd y
```
Ensure that `iscsid` and `multipathd` are running:
```
sudo systemctl enable iscsid multipathd && sudo systemctl start iscsid multipathd
```
Start and enable iSCSI:
```
sudo systemctl enable iscsi && sudo systemctl start iscsi
```
<br/>


**Ubuntu / Debian**  
Install the following system packages:
```
sudo apt-get install -y open-iscsi lsscsi sg3-utils multipath-tools scsitools
```
**Multipathing**  
`Multipath` is supported for the `iSCSI`-based drivers. Simply setup multipath to your liking and set multiple portals in the config as appropriate.  
*NOTE:* If you are running Kubernetes with Rancher/RKE please see the following:  
[Support host iscsi simultaneously with kubelet iscsi (pvc)](https://github.com/rancher/rke/issues/1846>)
<br/>

Add the mutlipath configuration:
```
sudo tee /etc/multipath.conf <<-'EOF'
defaults {
    user_friendly_names yes
    find_multipaths yes
}
EOF
```
Enable the `multipath-tools` service and restart to load the configuration:
```
sudo systemctl enable multipath-tools && sudo service multipath-tools restart
```
Ensure that `open-iscsi` and `multipath-tools` are enabled and running:
```
sudo systemctl status multipath-tools
sudo systemctl enable open-iscsi.service
sudo service open-iscsi start
sudo systemctl status open-iscsi
```
<br/>

### **FreeNAS-SMB** </span>  
___
If using with Windows based machines you may need to enable guest access (even
if you are connecting with credentials)

```
Set-ItemProperty HKLM:\SYSTEM\CurrentControlSet\Services\LanmanWorkstation\Parameters AllowInsecureGuestAuth -Value 1 ; Restart-Service LanmanWorkstation -Force
```
<br/>

### **ZFS-local-ephemeral-inline**
___
This `driver` provisions node-local ephemeral storage on a per-pod basis. Each node should have an identically named ZFS pool created and avaialble to the `driver`.  
*NOTE:* This is *NOT* the same thing as using the docker ZFS storage
driver (although the same pool could be used). No other requirements are
necessary. More regarding to this can be found here: [Pod Inline Volume Support](https://kubernetes-csi.github.io/docs/ephemeral-local-volumes.html)

<br/>

## **Storage server preperation**

Storage server preperation depends slightly on which `driver` you are using.
The recommended version of FreeNAS / TrueNAS is 12.0-U2 or higher, however the driver should work
with much older versions as well.

### **TrueNAS / FreeNAS (freenas-nfs, freenas-iscsi, freenas-smb, freenas-api-nfs, freenas-api-iscsi, freenas-api-smb)**  
<br/>

**API without SSH**  
___
Configuration templates can be found [HERE](https://github.com/D1StrX/democratic-csi/blob/667354978e497fb4624d52e909609ca278e4bd25/examples/api-with-ssh)  
The various `freenas-api-*` drivers are currently EXPERIMENTAL and can only be used with SCALE 21.08+. Fundamentally these drivers remove the need for `ssh` connections and do all operations entirely with the TrueNAS api. With that in mind, any `ssh/shell/etc` requirements below can be safely ignored. Also note the following known issues:

* [Additional middleware changes to support Democratic CSI use of native API](https://jira.ixsystems.com/browse/NAS-111870)
* [TrueNAS Scale 21.08 - Could not log into all portals](https://github.com/democratic-csi/democratic-csi/issues/112)
* [Pure api based truenas driver (ssh dependency removed)](https://github.com/democratic-csi/democratic-csi/issues/101)

[Continue configuration](#Service-configuration)
<br/>

**API with SSH**  
___
Configuration templates can be found [HERE](https://github.com/D1StrX/democratic-csi/blob/667354978e497fb4624d52e909609ca278e4bd25/examples/api-with-ssh)

[Continue configuration](#Service-configuration)
<br/>

### **Service configuration**  
Ensure the following services are *configured*, *running* and starting automatically:  

#### **SSH configuration** 
___
* When creating a custom user (e.g., `CSI`): 
  * Ensure `ZSH`, `BASH`, or `SH` is set as `shell`, `CSH` gives false errors due to quoting (also applicable when using `root`)  
  &emsp;![image](https://user-images.githubusercontent.com/40062371/147365044-007b2657-30f9-428b-ae12-7622a572866d.png)
  * Ensure that user has passwordless `sudo` privileges:  
    *NOTE:* This could get reset by FreeNAS if you alter the user via the GUI later
    * On TrueNAS CORE 12.0-u3 or higher, open the Shell:  
      ```
      cli
      ```
      After you enter the truenas cli and are at that prompt:
      ```
      account user query select=id,username,uid,sudo_nopasswd
      ```
      find the `id` of the user you want to update (note, this is distinct from the `uid`)

      ```
      account user update id=<id> sudo=true
      ```
      ```
      account user update id=<id> sudo_nopasswd=true
      ```
      (Optional) If you want to enable passwordless authentication via CLI:
      ```
      account user update id=<id> password_disabled=true
      ```
      Exit the CLI by pressing `ctrl-d`

    * On other versions add the user to the sudoers file:  
      ```
      visudo
      ```
      ```
      <username> ALL=(ALL) NOPASSWD:ALL
      ```
      Confirm sudoers file is appropriate:
      ```
      cat /usr/local/etc/sudoers
      ```
      
  * `CSI` has a homefolder, this is used to store its SSH Public Key  
  &emsp;![image](https://user-images.githubusercontent.com/40062371/147370105-6030b22e-ceb3-4768-b4a0-8e55fafe7f0f.png)
  * Add the user to `wheel` or create/use a group that will be used for permissions later on

<br/>

#### **NFS configuration**  
___
* Bind the interface to the NFS service
* It is recommended to use NFS 3

<br/>

#### **iSCSI configuration**  
___
*NOTE:* (Fixed in 12.0-U2+) when using the FreeNAS API concurrently, the `/etc/ctl.conf` file on the server can become invalid, some sample scripts are provided in the `contrib` directory to clean things up ie:  
Copy the script to the server and directly and run - `./ctld-config-watchdog-db.sh | logger -t ctld-config-watchdog-db.sh &`  
Please read the scripts and set the variables correctly for your server.
* Ensure you have pre*emptively created portals, initatior groups, auths
  * Make note of the respective IDs (the true ID may not reflect what is
    visible in the UI)
  * IDs can be visible by clicking the the `Edit` link and finding the ID in the
    browser address bar
  * Optionally you may use the following to retrieve appropiate IDs:
    * `curl --header "Accept: application/json" --user root:<password> 'http(s)://<ip>/api/v2.0/iscsi/portal'`
    * `curl --header "Accept: application/json" --user root:<password> 'http(s)://<ip>/api/v2.0/iscsi/initiator'`
    * `curl --header "Accept: application/json" --user root:<password> 'http(s)://<ip>/api/v2.0/iscsi/auth'`

<br/>

### **SMB configuration**  
___
* Bind the interface to the SMB service

<br/>

### **YAML Values configuration**
___

- Instruct `Democratic-CSI` to use `sudo` by adding the following to
  your driver configuration:

  ```
  zfs:
    cli:
      sudoEnabled: true
  ```

Starting with TrueNAS CORE 12 it is also possible to use an `apiKey` instead of
the user/root password for the HTTP connection.
The `apiKey` can be generated by clicking on the `Settings icon` -> `API Keys` -> `ADD`  
![image](https://user-images.githubusercontent.com/40062371/147371451-ff712de3-cce0-448e-b59f-29269179d2d6.png)

Issues to review:  
[ixsystems NAS-108519](https://jira.ixsystems.com/browse/NAS-108519)  
[ixsystems NAS-108520](https://jira.ixsystems.com/browse/NAS-108520)  
[ixsystems NAS-108521](https://jira.ixsystems.com/browse/NAS-108521)  
[ixsystems NAS-108522](https://jira.ixsystems.com/browse/NAS-108522)  
[ixsystems NAS-107219](https://jira.ixsystems.com/browse/NAS-107219)  

<br/>

### **ZoL (zfs-generic-nfs, zfs-generic-iscsi)**
___

Ensure ssh and zfs is installed on the nfs/iscsi server and that you have installed
`targetcli`.

 ```
 sudo yum install targetcli -y
 ```
 ```
 sudo apt-get -y install targetcli-fb
 ```

<br/>

### **Synology (synology-iscsi)**
___
Ensure iSCSI Manager has been installed and is generally setup/configured.

<br/>

## **Helm Installation**
___
Copy proper example Values file from the examples:  
[API without SSH](https://github.com/D1StrX/democratic-csi/blob/667354978e497fb4624d52e909609ca278e4bd25/examples/api-without-ssh)  
[API with SSH](https://github.com/D1StrX/democratic-csi/blob/667354978e497fb4624d52e909609ca278e4bd25/examples/api-with-ssh)  

Add the `Democratic-CSI` Helm repository:
```
helm search repo democratic-csi/
```
Update your Helm repository to get latest charts:
```
helm repo update
```

### **Helm V3**
___

Install `Democratic-CSI` with your configured values. Helm V3 requires that you `--create-namespace`
```
helm install zfs-nfs democratic-csi/democratic-csi --values truenas-isci.yaml --create-namespace democratic-csi
```
Update/Upgrade Values:
```
helm upgrade <name> democratic-csi/democratic-csi --values <freenas-*>.yaml --namespace <namespace>
```

### **Helm V2**
___
Install `Democratic-CSI` with your configured values.
```
helm upgrade \
--install \
--values freenas-nfs.yaml \
--namespace democratic-csi \
zfs-nfs democratic-csi/democratic-csi
```

### **On non standard Kubelet paths**

Some distrobutions, such as `minikube` and `microk8s` use a non-standard kubelet path. In such cases it is  ecessary to provide a new kubelet host path, microk8s example below:
```bash
microk8s helm upgrade \
  --install \
  --values freenas-nfs.yaml \
  --set node.kubeletHostPath="/var/snap/microk8s/common/var/lib/kubelet"  \
  --namespace democratic-csi \
  zfs-nfs democratic-csi/democratic-csi
```

* microk8s - `/var/snap/microk8s/common/var/lib/kubelet`
* pivotal - `/var/vcap/data/kubelet`

### **OpenShift**

`Democratic-CSI` generally works fine with openshift. Some special parameters
need to be set with helm (support added in chart version `0.6.1`):

```
# for sure required
--set node.rbac.openshift.privileged=true
--set node.driver.localtimeHostPath=false

# unlikely, but in special circumstances may be required
--set controller.rbac.openshift.privileged=true
```

### **Nomad**

`Democratic-CSI` works with Nomad in a functioning but limted capacity. See the [Nomad docs](docs/nomad.md) for details.

## **Multiple Deployments**

You may install multiple deployments of each/any driver. It requires the following:

- Use a new helm release name for each deployment
- Make sure you have a unique `csiDriver.name` in the values file
- Use unqiue names for your storage classes (per cluster)
- Use a unique parent dataset (ie: don't try to use the same parent across deployments or clusters)

## **Snapshot Support**  
Install beta (v1.17+) CRDs (one per cluster):

- https://github.com/kubernetes-csi/external-snapshotter/tree/master/client/config/crd

```
kubectl apply -f snapshot.storage.k8s.io_volumesnapshotclasses.yaml
kubectl apply -f snapshot.storage.k8s.io_volumesnapshotcontents.yaml
kubectl apply -f snapshot.storage.k8s.io_volumesnapshots.yaml
```

Install snapshot controller (once per cluster):

- https://github.com/kubernetes-csi/external-snapshotter/tree/master/deploy/kubernetes/snapshot-controller

```
# replace namespace references to your liking
kubectl apply -f rbac-snapshot-controller.yaml
kubectl apply -f setup-snapshot-controller.yaml
```

Install `Democratic-CSI` as usual with `volumeSnapshotClasses` defined as appropriate.

- https://kubernetes.io/docs/concepts/storage/volume-snapshots/
- https://github.com/kubernetes-csi/external-snapshotter#usage
- https://github.com/democratic-csi/democratic-csi/issues/129#issuecomment-961489810

## **Migrating from freenas-provisioner and freenas-iscsi-provisioner**  
It is possible to migrate all volumes from the non-csi freenas provisioners
to `Democratic-CSI`.

Copy the `contrib/freenas-provisioner-to-democratic-csi.sh` script from the
project to your workstation, read the script in detail, and edit the variables
to your needs to start migrating!

<br/>

# **Sponsors**

A special shout out to the wonderful sponsors of this project!

[![ixSystems](https://www.ixsystems.com/wp-content/uploads/2021/06/ix_logo_200x47.png "ixSystems")](http://ixsystems.com/)

<br/>

## **Related**

- https://github.com/nmaupu/freenas-provisioner
- https://github.com/travisghansen/freenas-iscsi-provisioner
- https://datamattsson.tumblr.com/post/624751011659202560/welcome-truenas-core-container-storage-provider
- https://github.com/dravanet/truenas-csi
- https://github.com/SynologyOpenSource/synology-csi
