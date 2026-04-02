# OpenWRT package feed for Regulatrix

Regulatrix is a package for regulating upload and download rates between a
local network and the Internet.

luci-app-regulatrix is a package for configuring and monitoring regulatrix.

## About Regulatrix

MAC addresses are used to specify the devices for which bandwidth should be regulated.
Each device will be put in a separate class with its own guaranteed rate and ceiling.

Separate qdiscs are set up for uploads and downloads.  Devices are added to them
as required by the config.

In addition, groups of IP addresses can be managed using a quota-based three-tiered
download bandwidth restriction system.
___

## Overview

Regulatrix uses qdiscs to allow the regulation of upload and download rates
between a local network and the Internet.  Its first option uses the MAC addresses of
network devices to define rules to limit their bandwidth usage.

This is especially useful for taming things like Ring Cameras which will happily
upload at 4k, but which will gracefully provide reasonable imagery at much lower
resolutions (even 300kbit) if you compel them to.

Likewise, video downloaders may attempt to receive the highest resolution
attainable but 720p might do just as well as 4k for many applications.  High
rates of movement will require more data, low levels less.

Ring recommendations for optimal quality.  Far lower rates may work very well:

```
    4k:	15Mbps
    2k:	10Mbps
 1536p:	2.5Mbps
 1080p:	2Mbps
 720p:	1Mbps
```
The MAC address rules are appropriate for fixed devices such as cameras or
televisions.  They are less useful for transient devices such as phones,
tablets, or devices which use variable MAC addresses - but which will also
display useful video at lower resolutions if bandwidth is restricted.  For
these devices a three-tiered quota-based download traffic shaping system is
available and may be applied to an address range (e.g. a dynamic DHCP range).
The system will step down the bandwidth available to these addresses at
configurable intervals.

Devices in the range start at full speed and are progressively throttled as they
consume data, using the iptables quota2 module. The quota subtree
attaches as a child of the default class 1:10, replacing the SFQ leaf qdisc.

For example, you may wish to allow web traffic to a phone at the full
bandwidth available on a channel.  But if extensive videos are to be viewed,
the automatic bandwidth restriction will eventually cause the video playback to drop to
1080p or lower, permitting satisfactory video playback with far less data.

The quota-based traffic shaping is based upon the idea in Sam Wilson's
trafficshaper.sh @ https://github.com/Kahn/scripts/tree/master/openwrt)
___

## Configuration

Look in /etc/config/regulatrix.conf for further information.  Alternatively,
install the package luci-app-regulatrix, which provides instructive screens
for configuring regulatrix as well as useful traffic monitoring and analysis
statistics.
___

## Usage

This repository is an OpenWRT package feed.
You may build the apk packages for OpenWRT by adding this line to the SDK's feed.conf:
```
    src-git signetica https://github.com/signetica/signetica-feed.git
```
Rebuild the feeds and make the APK, then install it with
```
apk add --allow-untrusted <apk filename>
```

Pre-built APKs for both luci-app-regulatrix and regulatrix are made available on github
for releases.

Regulatrix can be installed manually by copying three files into place:
```
    cp files/regulatrix.con /etc/config/regulatrix
    cp files/regulatrix.init /etc/init.d/regulatrix
    cp src/regulatrix.sh /usr/sbin/regulatrix
```

Make the last two files executable.
___

https://github.com/signetica/signetica-feed.git
