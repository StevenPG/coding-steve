---
author: StevenPG
pubDatetime: 2024-07-21T12:00:00.000Z
title: Homelab Drives & Buying Used
slug: buying-used-harddrives
featured: false
ogImage: /assets/default-og-image.png
tags:
  - hardware
description: An article with a short overview of my experiece buying used drives and using smartctl.
---

# Homelab Drives & Buying Used

Understanding the lifespan of your homelab's hard drives is crucial for maintaining data integrity and preventing unexpected downtime. 

This post will guide you through the process of checking your disk life and provide insights based on real-world examples from my homelab.

### Understanding Your Disk's Health
To assess your hard drive's health, you'll need two primary tools:

lsblk: Displays block devices with their mount points, label, UUID, and size.
smartctl: Retrieves S.M.A.R.T. data, which provides information about the drive's health, performance, and reliability.
Basic Commands:

```bash
sudo lsblk -f
sudo smartctl --all /dev/sda > output.txt
```


The first command lists your block devices, while the second saves the S.M.A.R.T. data of /dev/sda to a text file for analysis.

### Case Study: My Used Homelab Drives

I purchased a pair of used 2TB Seagate HDDs from ebay in a "lot" purchase.

The first thing I did was check the S.M.A.R.T data and see how good the "deal" was.

- Drive A: 125 power-on hours.
- Drive B: 23081 power-on hours (approximately 63 days running).

Based on the power-on hours, it's clear that the Seagate 2TB HDD with 23081 hours is approaching its expected lifespan.

In this case, I got a decent deal on the drives and I have them set up in a RAID configuration. This should allow me to
take advantage of the dual drive layout, but be well aware that Drive B is likely to fail and fallback to Drive A.

### Interpreting S.M.A.R.T. Data

While power-on hours provide a good basic estimate, a deeper analysis of S.M.A.R.T. data is crucial. 

We should look at the following attribute entries:

- Power On Hours: High values mean the drive is closer to end of life (EOL)
- Read/write errors: High values indicate potential issues.
- Reallocated sectors: An increasing number suggests the drive is failing.

Tools like smartctl make it easy to retrieve and help interpret this data.

### Proactive Measures for used drives

When buying used drives, it's good to act as though they could fail sooner than
brand new store-bought drives.


- Implement a reliable backup strategy to safeguard your data.
- Use tools like smartctl or dedicated monitoring software.
