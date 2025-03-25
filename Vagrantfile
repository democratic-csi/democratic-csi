Vagrant.configure("2") do |config|
    # Check the host's architecture
    host_arch = `uname -m`.strip

    # Use a different box for ARM vs x86_64
    if host_arch == "arm64"
        # requires qemu, install qemu and then:
        # vagrant plugin install vagrant-qemu
        config.vm.box = "perk/ubuntu-24.04-arm64" 
    else
        # Use the x86_64 compatible Ubuntu box
        config.vm.box = "ubuntu/jammy64"
    end
  
    config.vm.provider "virtualbox" do |vb|
      vb.memory = "2048"
      vb.cpus = 2
    end
  
    config.vm.provision "shell", inline: <<-SHELL
      sudo apt-get update -y

      # for building dependecies and executing node
      sudo apt-get install -y nodejs git make

      # for app functionality
      sudo apt-get install -y netbase socat e2fsprogs xfsprogs fatresize dosfstools nfs-common cifs-utils

       # Install the following system packages
      sudo apt-get install -y open-iscsi lsscsi sg3-utils multipath-tools scsitools nvme-cli

      # Enable multipathing
      sudo tee /etc/multipath.conf << EOF
      defaults {
          user_friendly_names yes
          find_multipaths yes
      }
      EOF

      sudo systemctl enable multipath-tools.service
  
      # Enable and start iscsid service
      sudo systemctl enable --now iscsid
  
      # Verify installation
      systemctl status iscsid --no-pager

      ####
      # Install golang
      ####
      GO_VERSION="1.24.1"
      ARCH=$(uname -m)
      GO_TAR_URL=""

      if [[ "$ARCH" == "aarch64" ]]; then
          GO_TAR_URL="https://go.dev/dl/go${GO_VERSION}.linux-arm64.tar.gz"
      elif [[ "$ARCH" == "x86_64" ]]; then
          GO_TAR_URL="https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz"
      else
          echo "Unsupported architecture: $ARCH"
          exit 1
      fi

      echo "Downloading Go version $GO_VERSION for $ARCH..."
      wget -q "$GO_TAR_URL" -O go.tar.gz
      tar -C /usr/local -xzf go.tar.gz
      rm go.tar.gz
      echo "export PATH=\$PATH:/usr/local/go/bin" >> /etc/profile
      source /etc/profile

      ####
      # Install csi-test
      ####
      echo "Installing csi-test"
      git clone https://github.com/kubernetes-csi/csi-test /tmp/csi-test
      pushd /tmp/csi-test/cmd/csi-sanity
      make csi-sanity
      sudo cp csi-sanity /usr/local/bin
      popd
    SHELL
  
    # Sync project directory for seamless workflow
    config.vm.synced_folder ".", "/home/vagrant/democratic-csi", type: "rsync",
        rsync__exclude: ".git/"
    
    # Allow SSH access with default key
    config.ssh.insert_key = false
  end  