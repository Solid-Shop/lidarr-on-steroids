#!/bin/bash

if [ "$CLEAN_DOWNLOADS" != "true" ]; then
    exit
fi

# Informational messages go to stdout so Lidarr's custom-script log forwarder
# labels them [Info] rather than [Error]. Genuine errors (e.g. permission
# failures from `find`) still go to stderr naturally and show as [Error].
echo "Info|Lidarr event: $lidarr_eventtype"

# Handle Lidarr Test event
if [[ "$lidarr_eventtype" = "Test" ]]; then
    echo "Info|Script was test executed successfully."
    exit 0
fi

echo "Info|Cleaning empty folders"
# -mindepth 1 prevents find from trying to delete /downloads itself, which is a
# volume mount root and not removable from inside the container.
find /downloads -mindepth 1 -type d -empty -print -delete
