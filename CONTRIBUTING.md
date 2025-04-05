# Contributing to democratic-csi

## Development Environment Setup

This project uses a hybrid development approach with devcontainers for IDE configuration and Vagrant for system-level testing.

### Prerequisites

Before you begin, ensure you have the following installed:
- [Visual Studio Code](https://code.visualstudio.com/)
- [Docker](https://www.docker.com/get-started)
- [Vagrant](https://www.vagrantup.com/downloads)
- Virtualization Provider:
  - For Intel/AMD Machines: VirtualBox
  - For Apple Silicon: Qemu (`brew install qemu vagrant` and `vagrant plugin install vagrant-qemu`)

### Development Workflow

#### 1. Local Development with Devcontainers

Devcontainers provide a consistent development environment with:
- Configured VSCode extensions
- Necessary development tools
- Integrated development experience

To use the devcontainer:
1. Open the project in VSCode
2. Install the "Dev Containers" extension
3. Click "Reopen in Container" when prompted
4. Start coding with pre-configured environment

> [!Note]
> For `iSCSI` it's mandatory to use the Vagrant VM, due to the need of a kernel driver.
> However for other tests the container is probably enough. It's possible to run the `hack/run.sh`
> as explained below in the devcontainer and see if it's possible, before spinning up a full VM.

#### 2. System Testing with Vagrant

Vagrant provides a full virtual machine environment for:
- System-level testing
- Running code with kernel dependencies
- Simulating production-like environments

Workflow:
```bash
# Navigate to project directory
cd ~/democratic-csi

# Start the Vagrant VM
vagrant up

# Connect to the VM
vagrant ssh

# Inside the VM, navigate to the project
cd ~/democratic-csi

# Run project tests, the config.yaml can be any from the examples folders
# just configured for your own environment.
# You can also create a file `dev/secrets.env` that has `export VARIABLE=VALUE`
# and reference those in your `config.yaml`
./hack/run.sh -c ./hack/config.yaml
```

##### Keeping Files in Sync

Use these methods to keep your local files synchronized with the Vagrant VM:

###### Manual Sync
```bash
# Sync files from local to Vagrant VM
vagrant rsync
```

###### Continuous Sync
```bash
# Automatically sync files as they change
vagrant rsync-auto
```

#### 3. Deploy development version to K8s cluster

Deployment provides a good environment for:
- Final testing in a real world scenario
- Run the final version until included in a release

> [!Note]
> Make sure to do the build on the architecture you will be running it.
> For example, don't build in Apple Silicon if your cluster runs in amd64.


1. Login to your github container registry
```bash
docker login ghcr.io
```

> [!Important]
> Login to the container registry is stored plain text, use a PAT instead of your Github password. [Create a PAT with write:packages](https://github.com/settings/tokens/new?scopes=write:packages).

2. Compile and push to your github container registry.
```bash
./hack/build_push.sh 
```

3. When you deploy, in the `values.yaml` add the following, using the output from the script
```yaml
controller:
  driver:
    image: ghcr.io/your_user/democratic-csi:your_branch-fc02fc4
node:
  driver:
    image: ghcr.io/your_user/democratic-csi:your_branch-fc02fc4
``` 

4. Make the Image Public

   By default, images pushed to GHCR are private. To make it public:
   1. Go to GitHub → Your Repository → Packages (or directly github.com/USERNAME?tab=packages)
   2. Select the package
   3. Click Package Settings
   4. Change Visibility to Public

### Best Practices

- Use devcontainer for day-to-day development and coding
- Use Vagrant for comprehensive system testing
- Always run `vagrant rsync` before running tests in the VM
- Commit and push changes frequently
- If encountering issues, try:
  1. Recreating the devcontainer
  2. Reprovisioning the Vagrant VM with `vagrant reload --provision` or `vagrant destroy -f && vagrant up`

### Troubleshooting

#### Devcontainer Issues
- Ensure Docker is running
- Rebuild the container if extensions fail to load
- Check VSCode Dev Containers extension logs

#### Vagrant Issues
- Verify virtualization is enabled in your BIOS
- Ensure you have the latest Vagrant and virtualization provider
- For Apple Silicon, use Parallels or Lima

### Contribution Guidelines

1. Create a new branch for your feature targetting `next`
2. Write clear, concise commit messages
3. Include coverage for tests of csi-sanity for new functionality
4. Run tests in Vagrant VM
5. Submit a pull request with a clear description of changes

### Contact

For any questions or issues, please [open an issue](https://github.com/democratic-csi/democratic-csi/issues) on the project repository.