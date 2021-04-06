#!/bin/sh -e

find ../lua/ -name "*.h" | ./create-bindings.js
