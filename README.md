# OpenWRT package feed
This repository contains one or more packages for managing networks on OpenWRT routers.
___

## Regulatrix
This package uses qdiscs to allow the regulation of upload and download rates
from a local network to the Internet.

It's especially useful for taming things like Ring Cameras which might want to
upload in 4k, but which will, if forced, provide useful imagery at much lower
resolutions.

Similarly, you might be quite happy watching 1080p video on a smaller device,
and if bandwith is tight you might prefer that to 4k.

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

(The --allow-untrusted allows you to install an unsigned apk)

If building your own apk is inconvenient, perhaps the apk will appear
in an official OpenWRT repository soon. Or perhaps the apk will appear here.
In the meanwhile, there are only three files and you can just copy them into
place.
