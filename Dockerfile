FROM debian:12-slim AS build
#FROM --platform=$BUILDPLATFORM debian:10-slim AS build

ENV DEBIAN_FRONTEND=noninteractive

ARG TARGETPLATFORM
ARG BUILDPLATFORM

RUN echo "I am running build on $BUILDPLATFORM, building for $TARGETPLATFORM"

RUN apt-get update && apt-get install -y locales && rm -rf /var/lib/apt/lists/* \
  && localedef -i en_US -c -f UTF-8 -A /usr/share/locale/locale.alias en_US.UTF-8

ENV LANG=en_US.utf8
ENV NODE_VERSION=v20.19.0
ENV NODE_ENV=production

# install build deps
RUN apt-get update && apt-get install -y python3 make cmake gcc g++

# install node
RUN apt-get update && apt-get install -y wget xz-utils
ADD docker/node-installer.sh /usr/local/sbin
RUN chmod +x /usr/local/sbin/node-installer.sh && node-installer.sh
ENV PATH=/usr/local/lib/nodejs/bin:$PATH

# Run as a non-root user
RUN useradd --create-home csi \
  && mkdir /home/csi/app \
  && chown -R csi: /home/csi
WORKDIR /home/csi/app
USER csi

COPY --chown=csi:csi package*.json ./
RUN npm install --only=production --grpc_node_binary_host_mirror=https://grpc-uds-binaries.s3-us-west-2.amazonaws.com/debian-buster
COPY --chown=csi:csi . .
RUN rm -rf docker


######################
# actual image
######################
FROM debian:12-slim

LABEL org.opencontainers.image.source https://github.com/democratic-csi/democratic-csi
LABEL org.opencontainers.image.url https://github.com/democratic-csi/democratic-csi
LABEL org.opencontainers.image.licenses MIT

ENV DEBIAN_FRONTEND=noninteractive
ENV DEMOCRATIC_CSI_IS_CONTAINER=true

ARG TARGETPLATFORM
ARG BUILDPLATFORM
ARG OBJECTIVEFS_DOWNLOAD_ID

RUN echo "I am running on final $BUILDPLATFORM, building for $TARGETPLATFORM"

RUN apt-get update && apt-get install -y locales && rm -rf /var/lib/apt/lists/* \
  && localedef -i en_US -c -f UTF-8 -A /usr/share/locale/locale.alias en_US.UTF-8

ENV LANG=en_US.utf8
ENV NODE_ENV=production

# Workaround for https://github.com/nodejs/node/issues/37219
RUN test $(uname -m) != armv7l || ( \
  apt-get update \
  && apt-get install -y libatomic1 \
  && rm -rf /var/lib/apt/lists/* \
  )

# install node
#ENV PATH=/usr/local/lib/nodejs/bin:$PATH
#COPY --from=build /usr/local/lib/nodejs /usr/local/lib/nodejs
COPY --from=build /usr/local/lib/nodejs/bin/node /usr/local/bin/node

# node service requirements
# netbase is required by rpcbind/rpcinfo to work properly
# /etc/{services,rpc} are required
RUN apt-get update && \
  apt-get install -y wget netbase zip bzip2 socat e2fsprogs exfatprogs xfsprogs btrfs-progs fatresize dosfstools ntfs-3g nfs-common cifs-utils fdisk gdisk cloud-guest-utils sudo rsync procps util-linux nvme-cli fuse3 && \
  rm -rf /var/lib/apt/lists/*

# TODO: remove nvme unique files

ARG RCLONE_VERSION=1.69.1
ADD docker/rclone-installer.sh /usr/local/sbin
RUN chmod +x /usr/local/sbin/rclone-installer.sh && rclone-installer.sh

ARG RESTIC_VERSION=0.18.0
ADD docker/restic-installer.sh /usr/local/sbin
RUN chmod +x /usr/local/sbin/restic-installer.sh && restic-installer.sh

ARG KOPIA_VERSION=0.19.0
ADD docker/kopia-installer.sh /usr/local/sbin
RUN chmod +x /usr/local/sbin/kopia-installer.sh && kopia-installer.sh

ARG YQ_VERSION=v4.45.1
ADD docker/yq-installer.sh /usr/local/sbin
RUN chmod +x /usr/local/sbin/yq-installer.sh && yq-installer.sh

# controller requirements
#RUN apt-get update && \
#        apt-get install -y ansible && \
#        rm -rf /var/lib/apt/lists/*

# install objectivefs
ARG OBJECTIVEFS_VERSION=7.2
ADD docker/objectivefs-installer.sh /usr/local/sbin
RUN chmod +x /usr/local/sbin/objectivefs-installer.sh && objectivefs-installer.sh

# install wrappers
ADD docker/iscsiadm /usr/local/sbin
RUN chmod +x /usr/local/sbin/iscsiadm

ADD docker/multipath /usr/local/sbin
RUN chmod +x /usr/local/sbin/multipath

## USE_HOST_MOUNT_TOOLS=1
ADD docker/mount /usr/local/bin/mount
RUN chmod +x /usr/local/bin/mount

## USE_HOST_MOUNT_TOOLS=1
ADD docker/umount /usr/local/bin/umount
RUN chmod +x /usr/local/bin/umount

ADD docker/zfs /usr/local/bin/zfs
RUN chmod +x /usr/local/bin/zfs
ADD docker/zpool /usr/local/bin/zpool
RUN chmod +x /usr/local/bin/zpool
ADD docker/oneclient /usr/local/bin/oneclient
RUN chmod +x /usr/local/bin/oneclient

# Run as a non-root user
RUN useradd --create-home csi \
  && chown -R csi: /home/csi

COPY --from=build --chown=csi:csi /home/csi/app /home/csi/app

WORKDIR /home/csi/app

EXPOSE 50051
ENTRYPOINT [ "bin/democratic-csi" ]
