const _ = require("lodash");
const GeneralUtils = require("./general");
const Powershell = require("./powershell").Powershell;

/**
 * https://kubernetes.io/blog/2021/08/16/windows-hostprocess-containers/
 * https://github.com/kubernetes-csi/csi-proxy/tree/master/pkg/os
 *
 * multipath notes:
 * - http://scst.sourceforge.net/mc_s.html
 * - https://github.com/kubernetes-csi/csi-proxy/pull/99
 * - https://docs.microsoft.com/en-us/azure/storsimple/storsimple-8000-configure-mpio-windows-server
 * - https://support.purestorage.com/Legacy_Documentation/Setting_the_MPIO_Policy
 * - https://docs.microsoft.com/en-us/powershell/module/mpio/?view=windowsserver2022-ps
 *
 * Get-WindowsFeature -Name 'Multipath-IO'
 * Add-WindowsFeature -Name 'Multipath-IO'
 *
 * Enable-MSDSMAutomaticClaim -BusType "iSCSI"
 * Disable-MSDSMAutomaticClaim -BusType "iSCSI"
 *
 * Get-MSDSMGlobalDefaultLoadBalancePolicy
 * Set-MSDSMGlobalLoadBalancePolicy -Policy RR
 *
 * synology woes:
 * - https://community.spiceworks.com/topic/2279882-synology-iscsi-will-not-disconnect-using-powershell-commands
 * - https://support.hpe.com/hpesc/public/docDisplay?docId=c01880810&docLocale=en_US
 * - https://askubuntu.com/questions/1159103/why-is-iscsi-trying-to-connect-on-ipv6-at-boot
 */
class Windows {
  constructor() {
    this.ps = new Powershell();
  }

  resultToArray(result) {
    if (!result.parsed) {
      result.parsed = [];
    }
    if (!Array.isArray(result.parsed)) {
      result.parsed = [result.parsed];
    }
  }

  uncPathToShare(path) {
    // UNC\<server>\<share>[\<path>\]
    if (path.startsWith("UNC")) {
      path = path.replace("UNC", "\\");
    }

    if (!path.startsWith("\\\\")) {
      path = `\\\\${path}`;
    }

    let parts = path.split("\\");
    return `\\\\${parts[2]}\\${parts[3]}`;
  }

  async GetRealTarget(path) {
    let item;
    let target;

    do {
      item = await this.GetItem(path);
      path = null;

      target = _.get(item, "Target.[0]", "");
      if (target.startsWith("UNC")) {
        let parts = target.split("\\", 3);
        return `\\\\${parts[1]}\\${parts[2]}`;
      } else if (target.startsWith("Volume")) {
        return `\\\\?\\${target}`;
      } else {
        path = target;
      }
    } while (path);
  }

  async GetItem(localPath) {
    let command;
    let result;
    command = 'Get-Item "$Env:localpath" | ConvertTo-Json';
    try {
      result = await this.ps.exec(command, {
        env: {
          localpath: localPath,
        },
      });
      return result.parsed;
    } catch (err) {}
  }

  async GetSmbGlobalMapping(remotePath) {
    let command;
    // cannot have trailing slash nor a path
    // must be \\<server>\<share>
    remotePath = this.uncPathToShare(remotePath);
    command =
      "Get-SmbGlobalMapping -RemotePath $Env:smbremotepath | ConvertTo-Json";
    try {
      return await this.ps.exec(command, {
        env: {
          smbremotepath: remotePath,
        },
      });
    } catch (err) {}
  }

  /**
   * Global in this context is allowed access by all users
   *
   * @param {*} remotePath
   * @param {*} username
   * @param {*} password
   */
  async NewSmbGlobalMapping(remotePath, username, password) {
    let result;
    let command;
    // -UseWriteThrough $true
    // cannot have trailing slash nor a path
    // must be \\<server>\<share>
    //
    // https://github.com/kubernetes-csi/csi-driver-smb/issues/219#issuecomment-781952587
    // -Persistent $false
    remotePath = this.uncPathToShare(remotePath);
    command =
      "$PWord = ConvertTo-SecureString -String $Env:smbpassword -AsPlainText -Force;$Credential = New-Object -TypeName System.Management.Automation.PSCredential -ArgumentList $Env:smbuser, $PWord;New-SmbGlobalMapping -RemotePath $Env:smbremotepath -Credential $Credential -RequirePrivacy $true";

    result = await this.GetSmbGlobalMapping(remotePath);
    if (!result) {
      await this.ps.exec(command, {
        env: {
          smbuser: username,
          smbpassword: password,
          smbremotepath: remotePath,
        },
      });
    }
  }

  async RemoveSmbGlobalMapping(remotePath) {
    let result;
    let command;
    // cannot have trailing slash nor a path
    // must be \\<server>\<share>
    remotePath = this.uncPathToShare(remotePath);
    command = "Remove-SmbGlobalMapping -RemotePath $Env:smbremotepath -Force";

    do {
      result = await this.GetSmbGlobalMapping(remotePath);
      if (result) {
        await this.ps.exec(command, {
          env: {
            smbremotepath: remotePath,
          },
        });
      }
    } while (result);
  }

  async NewSmbLink(remotePath, localPath) {
    let command;
    // trailing slash required
    // may include subdirectories on the share if desired
    if (!remotePath.endsWith("\\")) {
      remotePath = `${remotePath}\\`;
    }

    command =
      "New-Item -ItemType SymbolicLink $Env:smblocalPath -Target $Env:smbremotepath";
    await this.ps.exec(command, {
      env: {
        smblocalpath: localPath,
        smbremotepath: remotePath,
      },
    });
  }

  async NewIscsiTargetPortal(address, port) {
    let command;
    command =
      "New-IscsiTargetPortal -TargetPortalAddress ${Env:iscsi_tp_address} -TargetPortalPortNumber ${Env:iscsi_tp_port}";
    await this.ps.exec(command, {
      env: {
        iscsi_tp_address: address,
        iscsi_tp_port: port,
      },
    });
  }

  async RemoveIscsiTargetPortalByTargetPortalAddress(targetPortalAddress) {
    let command;
    command = `Remove-IscsiTargetPortal -TargetPortalAddress ${targetPortalAddress} -Confirm:$false`;
    await this.ps.exec(command);
  }

  async RemoveIscsiTargetPortalByTargetPortalAddressTargetPortalPort(
    targetPortalAddress,
    targetPortalPort
  ) {
    let command;
    command = `Get-IscsiTargetPortal -TargetPortalAddress ${targetPortalAddress} -TargetPortalPortNumber ${targetPortalPort} | Remove-IscsiTargetPortal -Confirm:$false`;
    await this.ps.exec(command);
  }

  async IscsiTargetIsConnectedByPortalAddressPortalPort(address, port, iqn) {
    let sessions = await this.GetIscsiSessionsByTargetNodeAddress(iqn);
    for (let session of sessions) {
      let connections = await this.GetIscsiConnectionsByIscsiSessionIdentifier(
        session.SessionIdentifier
      );
      for (let connection of connections) {
        if (
          connection.TargetAddress == address &&
          connection.TargetPortNumber == port
        ) {
          return true;
        }
      }
    }

    //process.exit(1);

    return false;
  }

  /**
   * -IsMultipathEnabled
   *
   * @param {*} address
   * @param {*} port
   * @param {*} iqn
   * @param {*} authType
   * @param {*} chapUser
   * @param {*} chapSecret
   */
  async ConnectIscsiTarget(
    address,
    port,
    iqn,
    authType,
    chapUser,
    chapSecret,
    multipath = false
  ) {
    let is_connected =
      await this.IscsiTargetIsConnectedByPortalAddressPortalPort(
        address,
        port,
        iqn
      );
    if (is_connected) {
      return;
    }

    let command;
    // -IsMultipathEnabled $([System.Convert]::ToBoolean(${Env:iscsi_is_multipath}))
    // -InitiatorPortalAddress
    command =
      "Connect-IscsiTarget -TargetPortalAddress ${Env:iscsi_tp_address} -TargetPortalPortNumber ${Env:iscsi_tp_port} -NodeAddress ${Env:iscsi_target_iqn} -AuthenticationType ${Env:iscsi_auth_type}";

    if (chapUser) {
      command += " -ChapUsername ${Env:iscsi_chap_user}";
    }

    if (chapSecret) {
      command += " -ChapSecret ${Env:iscsi_chap_secret}";
    }

    if (multipath) {
      command +=
        " -IsMultipathEnabled $([System.Convert]::ToBoolean(${Env:iscsi_is_multipath}))";
    }

    try {
      await this.ps.exec(command, {
        env: {
          iscsi_tp_address: address,
          iscsi_tp_port: port,
          iscsi_target_iqn: iqn,
          iscsi_auth_type: authType,
          iscsi_chap_user: chapUser,
          iscsi_chap_secret: chapSecret,
          iscsi_is_multipath: String(multipath),
        },
      });
    } catch (err) {
      let details = _.get(err, "stderr", "");
      if (
        !details.includes(
          "The target has already been logged in via an iSCSI session"
        )
      ) {
        throw err;
      }
    }
  }

  async GetIscsiTargetsByTargetPortalAddressTargetPortalPort(address, port) {
    let command;
    let result;

    command =
      "Get-IscsiTargetPortal -TargetPortalAddress ${Env:iscsi_tp_address} -TargetPortalPortNumber ${Env:iscsi_tp_port} | Get-IscsiTarget | ConvertTo-Json";
    result = await this.ps.exec(command, {
      env: {
        iscsi_tp_address: address,
        iscsi_tp_port: port,
      },
    });
    this.resultToArray(result);

    return result.parsed;
  }

  /**
   * This disconnects *all* sessions from the target
   *
   * @param {*} nodeAddress
   */
  async DisconnectIscsiTargetByNodeAddress(nodeAddress) {
    let command;

    // https://github.com/PowerShell/PowerShell/issues/17306
    command = `Disconnect-IscsiTarget -NodeAddress ${nodeAddress.toLowerCase()} -Confirm:$false`;
    await this.ps.exec(command);
  }

  async GetIscsiConnectionsByIscsiSessionIdentifier(iscsiSessionIdentifier) {
    let command;
    let result;

    command = `Get-IscsiSession -SessionIdentifier ${iscsiSessionIdentifier} | Get-IscsiConnection | ConvertTo-Json`;
    result = await this.ps.exec(command);
    this.resultToArray(result);

    return result.parsed;
  }

  async GetIscsiSessions() {
    let command;
    let result;

    command = `Get-IscsiSession | ConvertTo-Json`;
    result = await this.ps.exec(command);
    this.resultToArray(result);

    return result.parsed;
  }

  async GetIscsiSessionsByDiskNumber(diskNumber) {
    let command;
    let result;

    command = `Get-Disk -Number ${diskNumber} | Get-IscsiSession | ConvertTo-Json`;
    result = await this.ps.exec(command);
    this.resultToArray(result);

    return result.parsed;
  }

  async GetIscsiSessionsByVolumeId(volumeId) {
    let sessions = [];
    let disks = await this.GetDisksByVolumeId(volumeId);
    for (let disk of disks) {
      let i_sessions = await this.GetIscsiSessionsByDiskNumber(disk.DiskNumber);
      sessions.push(...i_sessions);
    }

    return sessions;
  }

  async GetIscsiSessionsByTargetNodeAddress(targetNodeAddress) {
    let sessions = await this.GetIscsiSessions();
    let r_sessions = [];
    // Where-Object { $_.TargetNodeAddress -eq ${targetNodeAddress} }
    for (let session of sessions) {
      if (session.TargetNodeAddress == targetNodeAddress) {
        r_sessions.push(session);
      }
    }

    return r_sessions;
  }

  async GetIscsiSessionByIscsiConnectionIdentifier(iscsiConnectionIdentifier) {
    let command;
    let result;

    command = `Get-IscsiConnection -ConnectionIdentifier ${iscsiConnectionIdentifier} | Get-IscsiSession | ConvertTo-Json`;
    result = await this.ps.exec(command);

    return result.parsed;
  }

  async GetIscsiTargetPortalBySessionId(sessionId) {
    let command;
    let result;

    command = `Get-IscsiSession -SessionIdentifier ${sessionId} | Get-IscsiTargetPortal | ConvertTo-Json`;
    result = await this.ps.exec(command);

    return result.parsed;
  }

  async UpdateHostStorageCache() {
    let command;
    command = "Update-HostStorageCache";
    await this.ps.exec(command);
  }

  async GetIscsiDisks() {
    let command;
    let result;

    command = "Get-iSCSISession | Get-Disk | ConvertTo-Json";
    result = await this.ps.exec(command);
    this.resultToArray(result);

    return result.parsed;
  }

  async GetWin32DiskDrives() {
    let command;
    let result;

    command = "Get-WmiObject Win32_DiskDrive | ConvertTo-Json";
    result = await this.ps.exec(command);
    this.resultToArray(result);

    return result.parsed;
  }

  async GetDiskLunByDiskNumber(diskNumber) {
    let result;
    result = await this.GetWin32DiskDrives();
    for (let drive of result) {
      if (drive.Index == diskNumber) {
        return drive.SCSILogicalUnit;
      }
    }
  }

  async GetTargetDisks(address, port, iqn) {
    let command;
    let result;

    // this fails for synology for some reason
    //command =
    //  '$ErrorActionPreference = "Stop"; $tp = Get-IscsiTargetPortal -TargetPortalAddress ${Env:iscsi_tp_address} -TargetPortalPortNumber ${Env:iscsi_tp_port}; $t = $tp | Get-IscsiTarget | Where-Object { $_.NodeAddress -eq ${Env:iscsi_target_iqn} }; $s = Get-iSCSISession -IscsiTarget $t; $s | Get-Disk | ConvertTo-Json';

    command =
      '$ErrorActionPreference = "Stop"; $s = Get-iSCSISession | Where-Object { $_.TargetNodeAddress -eq ${Env:iscsi_target_iqn} }; $s | Get-Disk | ConvertTo-Json';

    result = await this.ps.exec(command, {
      env: {
        iscsi_tp_address: address,
        iscsi_tp_port: port,
        iscsi_target_iqn: iqn,
      },
    });
    this.resultToArray(result);

    return result.parsed;
  }

  async GetTargetDisksByIqn(iqn) {
    let command;
    let result;

    command =
      '$ErrorActionPreference = "Stop"; $s = Get-iSCSISession | Where-Object { $_.TargetNodeAddress -eq ${Env:iscsi_target_iqn} }; $s | Get-Disk | ConvertTo-Json';

    result = await this.ps.exec(command, {
      env: {
        iscsi_target_iqn: iqn,
      },
    });
    this.resultToArray(result);

    return result.parsed;
  }

  /**
   * This can be multiple when mpio is not configured properly and each
   * session creates a new disk
   *
   * @param {*} iqn
   * @param {*} lun
   * @returns
   */
  async GetTargetDisksByIqnLun(iqn, lun) {
    let result;
    let dlun;
    let disks = [];

    result = await this.GetTargetDisksByIqn(iqn);
    for (let disk of result) {
      dlun = await this.GetDiskLunByDiskNumber(disk.DiskNumber);
      if (dlun == lun) {
        disks.push(disk);
      }
    }

    return disks;
  }

  async GetDiskByDiskNumber(diskNumber) {
    let command;
    let result;

    command = `Get-Disk -Number ${diskNumber} | ConvertTo-Json`;
    result = await this.ps.exec(command);

    return result.parsed;
  }

  async GetDisks() {
    let command;
    let result;

    command = "Get-Disk | ConvertTo-Json";
    result = await this.ps.exec(command);
    this.resultToArray(result);

    return result.parsed;
  }

  async GetPartitions() {
    let command;
    let result;

    command = "Get-Partition | ConvertTo-Json";
    result = await this.ps.exec(command);
    this.resultToArray(result);

    return result.parsed;
  }

  async GetPartitionsByDiskNumber(diskNumber) {
    let command;
    let result;

    command = `Get-Disk -Number ${diskNumber} | Get-Partition | ConvertTo-Json`;
    result = await this.ps.exec(command);
    this.resultToArray(result);

    return result.parsed;
  }

  async DiskIsInitialized(diskNumber) {
    let disk = await this.GetDiskByDiskNumber(diskNumber);

    return disk.PartitionStyle != "RAW";
  }

  async InitializeDisk(diskNumber) {
    let command;

    command = `Initialize-Disk -Number ${diskNumber} -PartitionStyle GPT`;
    await this.ps.exec(command);
  }

  async DiskHasBasicPartition(diskNumber) {
    let command;
    let result;

    command = `Get-Partition | Where DiskNumber -eq ${diskNumber} | Where Type -ne Reserved | ConvertTo-Json`;
    result = await this.ps.exec(command);
    this.resultToArray(result);

    return result.parsed.length > 0;
  }

  async NewPartition(diskNumber) {
    let command;

    command = `New-Partition -DiskNumber ${diskNumber} -UseMaximumSize`;
    await this.ps.exec(command);
  }

  async PartitionDisk(diskNumber) {
    let is_intialized;
    let has_basic_partition;

    is_intialized = await this.DiskIsInitialized(diskNumber);
    if (!is_intialized) {
      await this.InitializeDisk(diskNumber);
    }

    has_basic_partition = await this.DiskHasBasicPartition(diskNumber);
    if (!has_basic_partition) {
      await this.NewPartition(diskNumber);
    }
  }

  async GetLastPartitionByDiskNumber(diskNumber) {
    let partitions = await this.GetPartitionsByDiskNumber(diskNumber);
    let p;
    for (let partition of partitions) {
      if (!p) {
        p = partition;
      }

      if (partition.PartitionNumber > p.PartitionNumber) {
        p = partition;
      }
    }

    return p;
  }

  async GetVolumesByDiskNumber(diskNumber) {
    let command;
    command = `Get-Disk -Number ${diskNumber} | Get-Partition | Get-Volume | ConvertTo-Json`;
    result = await this.ps.exec(command);
    this.resultToArray(result);

    return result.parsed;
  }

  async GetVolumeByDiskNumberPartitionNumber(diskNumber, partitionNumber) {
    let command;
    let result;

    command = `Get-Disk -Number ${diskNumber} | Get-Partition -PartitionNumber ${partitionNumber} | Get-Volume | ConvertTo-Json`;
    result = await this.ps.exec(command);

    return result.parsed;
  }

  async GetVolumeByVolumeId(volumeId) {
    let command;
    let result;

    command = `Get-Volume -UniqueId \"${volumeId}\" -ErrorAction Stop | ConvertTo-Json`;
    result = await this.ps.exec(command);

    return result.parsed;
  }

  async GetPartitionsByVolumeId(volumeId) {
    let partitions = await this.GetPartitions();
    let p = [];
    for (let partition of partitions) {
      let paths = _.get(partition, "AccessPaths", []);
      if (paths === null) {
        paths = [];
      }
      if (!Array.isArray(paths)) {
        paths = [];
      }
      if (paths.includes(volumeId)) {
        p.push(partition);
      }
    }
    return p;
  }

  async GetDisksByVolumeId(volumeId) {
    let partitions = await this.GetPartitionsByVolumeId(volumeId);
    let diskNumbers = new Set();
    for (let parition of partitions) {
      diskNumbers.add(parition.DiskNumber);
    }

    let disks = [];
    let disk;
    for (let diskNumber of diskNumbers) {
      disk = await this.GetDiskByDiskNumber(diskNumber);
      if (disk) {
        disks.push(disk);
      }
    }

    return disks;
  }

  async VolumeIsFormatted(volumeId) {
    let volume = await this.GetVolumeByVolumeId(volumeId);
    let type = volume.FileSystemType || "";
    type = type.toLowerCase().trim();
    if (!type || type == "unknown") {
      return false;
    }

    return true;
  }

  async VolumeIsIscsi(volumeId) {
    let disks = await this.GetDisksByVolumeId(volumeId);
    for (let disk of disks) {
      if (_.get(disk, "BusType", "").toLowerCase() == "iscsi") {
        return true;
      }
    }

    return false;
  }

  async FormatVolume(volumeId) {
    let command;
    command = `Get-Volume -UniqueId \"${volumeId}\" | Format-Volume -FileSystem ntfs -Confirm:$false`;
    await this.ps.exec(command);
  }

  async ResizeVolume(volumeId, size = 0) {
    let command;
    let final_size;

    if (!size) {
      final_size = await this.GetVolumeMaxSize(volumeId);
    } else {
      final_size = size;
    }

    let current_size = await this.GetVolumeSize(volumeId);
    if (current_size >= final_size) {
      return;
    }

    command = `Get-Volume -UniqueId \"${volumeId}\" | Get-Partition | Resize-Partition -Size ${final_size}`;
    try {
      await this.ps.exec(command);
    } catch (err) {
      let details = _.get(err, "stderr", "");
      if (
        !details.includes(
          "The size of the extent is less than the minimum of 1MB"
        )
      ) {
        throw err;
      }
    }
  }

  async GetVolumeMaxSize(volumeId) {
    let command;
    let result;

    command = `Get-Volume -UniqueId \"${volumeId}\" | Get-partition | Get-PartitionSupportedSize | Select SizeMax | ConvertTo-Json`;
    result = await this.ps.exec(command);
    return result.parsed.SizeMax;
  }
  async GetVolumeSize(volumeId) {
    let command;
    let result;

    command = `Get-Volume -UniqueId \"${volumeId}\" | Get-partition | ConvertTo-Json`;
    result = await this.ps.exec(command);

    return result.parsed.Size;
  }

  async MountVolume(volumeId, path) {
    let command;
    command = `Get-Volume -UniqueId \"${volumeId}\" | Get-Partition | Add-PartitionAccessPath -AccessPath ${path}`;

    await this.ps.exec(command);
  }

  async UnmountVolume(volumeId, path) {
    let command;

    // this errors if it does not have a drive letter
    if (!GeneralUtils.hasWindowsDriveLetter(path)) {
      let item = await this.GetItem(path);
      if (!item) {
        return;
      }
      path = item.FullName;
    }

    command = `Get-Volume -UniqueId \"${volumeId}\" | Get-Partition | Remove-PartitionAccessPath -AccessPath ${path}`;

    await this.ps.exec(command);
  }

  async WriteVolumeCache(volumeId) {
    let command;
    command = `Get-Volume -UniqueId \"${volumeId}\" | Write-Volumecache`;

    await this.ps.exec(command);
  }
}

module.exports.Windows = Windows;
