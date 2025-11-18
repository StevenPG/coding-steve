---
author: StevenPG
pubDatetime: 2025-10-28T12:00:00.000Z
title: Latitude/Longitude Distance Decrypted
slug: latitude-longitude-distance-decrypted
featured: false
ogImage: /assets/17e73d45-30ad-4daf-a92b-6333eec91b89.png
tags:
  - cesium
  - gis
description: Deciphering latitude and longitude and their relation to meters for Cesium!
---

# Latitude and Longitude

Latitude and longitude are decimal representations of a singular point on the Earth's surface, used across many
Geograhic Information Systems (GIS) applications.

The equator is the baseline of latitude, and the prime meridian is the baseline of longitude. Positive latitudes are
above the equator, and negative latitudes are below the equator. Positive longitudes are to the east of the prime
meridian, and negative longitudes are to the west of the prime meridian.

With that out of the way, let's get into the purpose of this short post; deciphering latitudes and longitudes mean
in relation to each other.

## Precision

First, we need to understand the precision of latitude and longitude. Each decimal place represents a finer level of
detail:

At the equator, the difference between two latitude or longitudinal points is:

| Decimal Places | Distance (meters) |
|----------------|-------------------|
| 1.0            | 111 km            |
| 0.1            | 11.1 km           |
| 0.01           | 1.11 km           |
| 0.001          | 111 m             |
| 0.0001         | 11.1 m            |
| 0.00001        | 1.11 m            |
| 0.000001       | 111 mm            |
| 0.0000001      | 11.1 mm           |
| 0.00000001     | 1.11 mm           |

This is the furthest distance between latitude and longitude points, as the Earth is widest at the equator. As you move
towards the poles, the distance represented by a degree of latitude or longitude decreases.

We can see by calculating the distance between two points and increase northward in an example, that the distance
decreases
even though the latitude will be the same.

(At Latitude 0)

| Latitude | Distance between Longitude 25->40 | Distance between Lon 25->26 |
|----------|-----------------------------------|-----------------------------|
| 0        | 556 km                            | 111                         |
| 10       | 547 km                            | 109                         |
| 20       | 522 km                            | 104                         |
| 30       | 481 km                            | 96                          |
| 40       | 426 km                            | 85                          |
| 50       | 357 km                            | 71                          |
| 60       | 278 km                            | 55                          |
| 70       | 190 km                            | 38                          |
| 80       | 96 km                             | 19                          |
| 89       | 10 km                             | 2                           |
| 90       | 0 km                              | 0                           |

We can clearly see that the distance decreases as latitude increases, bringing us closer to
the north pole. Here's what this looks like visually (using the 25-40 example):

![lon_lat_example.png](/assets/lon_lat_example.png)

## Usage in Cesium

When using Cesium, latitude and longitude are used to represent the position of a point on the Earth's surface. However,
it's important to use the correct calculation to determine distance, as where you are in the world determines the actual value.

If you were to use `Cesium.Cartesian3.distance(point1, point2)` to determine the distance between two points, you would
get the wrong result.` Rather than get the track across the globe's surface, you would get the distance between the two
points in a direct line. In small distances, this might seem correct, but would get more obvious as the distances get larger.

To get the correct distance, you need to use [EllipsoidGeodesic][ellipsoidgeodesic].

The `EllipsoidGeodesic` class is used to calculate the distance between two points on the surface of an ellipsoid.

Here's an example of how to use it:

```javascript
var startCartesian3Point = Cesium.Cartesian3.fromDegrees(48.862165, 2.305189);
var endCartesian3Point = Cesium.Cartesian3.fromDegrees(45.755675, 4.822185);

var startCartographicPoint = Cesium.Cartographic.fromCartesian(startCartesian3Point);
var endCartographicPoint = Cesium.Cartographic.fromCartesian(endCartesian3Point);

var ellipsoidGeodesic = new Cesium.EllipsoidGeodesic(startCartographicPoint, endCartographicPoint);
var distance = ellipsoidGeodesic.surfaceDistance; // Distance in meters
var distanceInKm = distance * 0.001; // Convert to kilometers

console.log('Geodesic distance: ' + distanceInKm + ' Km');
```

Distance is a common "gotcha" when doing Cesium development, and it's important to understand how to use it correctly.

Plus, I like having a quick reference for distances the next time I need it!

[ellipsoidgeodesic]: https://cesium.com/learn/cesiumjs/ref-doc/EllipsoidGeodesic.html
