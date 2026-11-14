---
title: HowLongToCook
description: "Keep the cooking instructions after the box is gone. An Android app that saves the cooking steps for frozen and packaged meals, keyed by barcode or name."
url: https://github.com/StevenPG/HowLongToCook
image: /assets/projects/howlongtocook.png
types:
  - Android App
  - Self-hosted
tags:
  - Kotlin
  - Rust
featured: true
order: 7
---

Keep the cooking instructions after the box is gone. HowLongToCook is an Android app for saving the cooking instructions of frozen and packaged meals, keyed by barcode or name, so they can be found again after the box is recycled. Scan a barcode with the camera (ZXing + CameraX), store structured microwave, oven, air-fryer and stovetop steps, and follow along in a large-text "Cook mode".

Data stays on the device and syncs in the background to Amazon S3, Cloudflare R2, any S3-compatible store, or an optional self-hosted Rust server with a lightweight admin UI. No accounts, no telemetry.

The app is built with Kotlin, Jetpack Compose (Material 3), Hilt, Room and Ktor. The server is Rust (axum + SQLite), published as the container image `ghcr.io/stevenpg/howlongtocook-server` and deployable with Docker or Kubernetes.

Grab an APK from the [releases page](https://github.com/StevenPG/HowLongToCook/releases), or browse the source on [GitHub](https://github.com/StevenPG/HowLongToCook). Licensed GPL-3.0-or-later.
