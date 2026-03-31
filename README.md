# OpenWRT package feed
This repository contains one or more packages for managing networks on OpenWRT routers.
___

## Regulatrix
This package uses qdiscs to allow the regulation of upload and download rates
from a local network to the Internet.  The MAC address of network devices
are used to identify and regulate them.

It's especially useful for taming things like Ring Cameras which might want to
upload in 4k, but which will, if forced, provide useful imagery at much lower
resolutions.

Similarly, you might be quite happy watching 1080p video on a smaller device.
If bandwidth is tight you might prefer that to 4k.

Because this software uses MAC addresses to regulate hosts, it will not work
repeatably on devices which select randomized MAC addresses for each session.
In general randomized addresses can be turned off on selected networks -
you should do this on networks you want to manage with this software,

The script and the config file included in this package contain information
about how to configure and use this software.  Look in src/regulatrix.sh and
files/regulatrix.conf.

## Usage
While the packaging is for OpenWRT's apk packaging system, the scripts are
more broadly useful for Linux systems and you should have no real trouble
manually installing them on such systems.

You may build the apk packages for OpenWRT by adding this line to the SDK's feed.conf:
```
    src-git signetica https://github.com/signetica/signetica-feed.git
```
Rebuild the feeds and make the APK, then install it with
```
apk add --allow-untrusted <apk filename>
```

(Use --allow-untrusted if you leave the apk unsigned)

If building your own apk is inconvenient, perhaps the apk will appear in an
official OpenWRT repository soon?  A pre-built version is also present in this
repository.

Or, since there are only three files, you can just copy them into place:
/etc/config/regulatrix, /etc/init.d/regulatrix and /usr/sbin/regulatrix.  Make
the last two executable.
___

## luci-app-regulatrix
This package is a luci module that provides a graphical interface to regulatrix.

In addition to providing a means of configuring regulatrix, it can display
statistics about how the traffic control is functioning.
