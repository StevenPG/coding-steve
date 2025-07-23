---
author: StevenPG
pubDatetime: 2025-06-15T12:00:00.000Z
title: Getting Camera Height in Cesium.js - A Complete Guide
slug: getting-camera-height-cesium-js
featured: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - cesium
  - javascript
description: A comprehensive tutorial on how to retrieve and display camera height in Cesium.js, including terrain-relative altitude calculations.
---

## Table of Contents

[[toc]]

## Brief

When working with 3D geospatial visualizations in Cesium.js, understanding and using camera height is essential for many applications. Whether you're building terrain analysis tools or interactive globe experiences, knowing how to accurately retrieve the camera's altitude is a fundamental skill.

This tutorial will walk you through the process of getting camera height in Cesium.js, including how to calculate height relative to terrain. We'll explore the different components involved and provide practical code examples that you can adapt for your own projects.

## Understanding Camera Position in Cesium

Before diving into the code, it's important to understand how Cesium represents positions in 3D space.

### Coordinate Systems in Cesium

Cesium uses several coordinate systems, but the most relevant for camera height are:

1. **Cartesian3**: A 3D position in Earth-centered, Earth-fixed (ECEF) coordinates
2. **Cartographic**: A position in longitude, latitude, and height (in radians and meters)

The camera's position is typically represented as a Cartesian3, but for altitude calculations, we need to work with Cartographic coordinates.

### The Camera Object

The `Camera` class in Cesium provides access to the viewer's perspective. It includes properties like:

- `position`: The camera's position as a Cartesian3
- `positionCartographic`: The camera's position as a Cartographic (longitude, latitude, height)
- `direction`: The camera's viewing direction
- `changed`: An event that fires when the camera position changes

## Basic Camera Height Retrieval

The simplest way to get the camera's height is through the `positionCartographic` property:

```javascript
// Assuming you have a Cesium viewer instance
const viewer = new Cesium.Viewer('cesiumContainer');

// Get the camera's height above the ellipsoid (in meters)
const height = viewer.camera.positionCartographic.height;
console.log(`Camera height: ${height.toFixed(2)} meters`);
```

This gives you the height above the WGS84 ellipsoid (a mathematical model of the Earth's shape), not the actual terrain height. For many applications, this is sufficient, but if you need height relative to the terrain, you'll need additional steps.

## Height Above Terrain

To calculate the camera's height above the actual terrain, you need to:

1. Get the camera's position
2. Sample the terrain height at that position
3. Calculate the difference

Here's how to do it:

```javascript
// Get the camera's cartographic position
const cameraPosition = viewer.camera.positionCartographic;

// Sample the terrain at the camera's position
const terrainProvider = viewer.terrainProvider;
if (terrainProvider) {
  // Create a position with the same longitude/latitude but zero height
  const terrainSamplePosition = new Cesium.Cartographic(
    cameraPosition.longitude,
    cameraPosition.latitude,
    0
  );
  
  // Sample the terrain height at this position
  Cesium.sampleTerrainMostDetailed(terrainProvider, [terrainSamplePosition])
    .then(updatedPositions => {
      // Calculate height above terrain
      const terrainHeight = updatedPositions[0].height;
      const heightAboveTerrain = cameraPosition.height - terrainHeight;
      
      console.log(`Terrain height: ${terrainHeight.toFixed(2)} meters`);
      console.log(`Height above terrain: ${heightAboveTerrain.toFixed(2)} meters`);
    });
}
```

This approach gives you a more accurate representation of how high the camera is above the actual ground.

## Performance Considerations

Sampling terrain can be computationally expensive, especially at high frequencies. If you're updating the height display continuously (e.g., during camera movement), consider these optimizations:

1. **Throttle updates**: Don't sample terrain on every frame; use a timer or the camera's `percentageChanged` property
2. **Use different methods based on altitude**: At high altitudes, the difference between ellipsoid height and terrain height becomes less significant

Here's an implementation that addresses these concerns:

```javascript
// Constants
const SAMPLE_HEIGHT_THRESHOLD = 10000; // meters
const CAMERA_PERCENTAGE_CHANGE = 0.01; // trigger updates when camera moves by 1%

// Set up camera change listener
viewer.camera.percentageChanged = CAMERA_PERCENTAGE_CHANGE;
viewer.camera.changed.addEventListener(() => {
  const cameraPosition = viewer.camera.positionCartographic;
  
  // At high altitudes, just use ellipsoid height
  if (cameraPosition.height > SAMPLE_HEIGHT_THRESHOLD) {
    updateHeightDisplay(cameraPosition.height);
    return;
  }
  
  // At lower altitudes, calculate height above terrain
  const terrainProvider = viewer.terrainProvider;
  if (terrainProvider) {
    const samplePosition = new Cesium.Cartographic(
      cameraPosition.longitude,
      cameraPosition.latitude,
      0
    );
    
    Cesium.sampleTerrainMostDetailed(terrainProvider, [samplePosition])
      .then(updatedPositions => {
        const terrainHeight = updatedPositions[0].height;
        const heightAboveTerrain = Math.max(0, cameraPosition.height - terrainHeight);
        updateHeightDisplay(heightAboveTerrain);
      });
  } else {
    // No terrain provider, fall back to ellipsoid height
    updateHeightDisplay(cameraPosition.height);
  }
});

// Function to update UI with height value
function updateHeightDisplay(height) {
  // Format height with appropriate units
  let displayHeight;
  let units;
  
  if (height > 1000) {
    displayHeight = (height / 1000).toFixed(1);
    units = 'km';
  } else {
    displayHeight = Math.round(height);
    units = 'm';
  }
  
  // Update UI element
  document.getElementById('heightDisplay').textContent = `${displayHeight} ${units}`;
}
```

## Building an Altitude Indicator Component

Let's put everything together to create a reusable altitude indicator component using React and Cesium. This component will display the camera's height above terrain with a visual slider:

```jsx
import React, { useEffect, useState } from "react";
import * as Cesium from "cesium";
import { useCesiumContext } from "../contexts/CesiumContext";

export default function AltitudeIndicator() {
  const SAMPLE_HEIGHT = 10000;
  const PERCENTAGE_CHANGE = 0.01;
  
  const viewer = useCesiumContext();
  const [altitude, setAltitude] = useState(0);
  const [units, setUnits] = useState("m");
  
  useEffect(() => {
    if (viewer?.camera) {
      // Initial height calculation
      calculateHeight(viewer.camera.positionCartographic.height);
      
      // Set up camera change listener
      viewer.camera.percentageChanged = PERCENTAGE_CHANGE;
      const changeListener = function() {
        const provider = viewer.terrainProvider;
        const positionCartographic = viewer.camera.positionCartographic;
        
        if (provider && positionCartographic.height <= SAMPLE_HEIGHT) {
          // For lower altitudes, calculate height above terrain
          Cesium.sampleTerrainMostDetailed(
            provider, 
            [new Cesium.Cartographic(positionCartographic.longitude, positionCartographic.latitude, 0)]
          ).then(value => {
            const terrainHeight = value[0].height;
            const heightAboveTerrain = Math.max(0, positionCartographic.height - terrainHeight);
            calculateHeight(heightAboveTerrain);
          });
        } else {
          // For higher altitudes or when no terrain provider exists,
          // use ellipsoid height
          calculateHeight(positionCartographic.height);
        }
      };
      
      viewer.camera.changed.addEventListener(changeListener);
      
      // Clean up listener on component unmount
      return () => {
        if (viewer?.camera) {
          viewer.camera.changed.removeEventListener(changeListener);
        }
      };
    }
  }, [viewer?.camera]);
  
  const calculateHeight = (height) => {
    // Format height with appropriate units
    if (height > 1000) {
      setAltitude((height / 1000).toFixed(1));
      setUnits("km");
    } else {
      setAltitude(Math.round(height));
      setUnits("m");
    }
  };
  
  return (
    <div className="altitude-indicator">
      <div className="altitude-value">{altitude} {units}</div>
      <div className="altitude-bar">
        <div 
          className="altitude-fill" 
          style={{ height: `${Math.min(100, (altitude / (units === "km" ? 10 : 1000)) * 100)}%` }}
        />
      </div>
    </div>
  );
}
```

This component:
1. Uses a Cesium context to access the viewer
2. Sets up a camera change listener
3. Calculates height above terrain for lower altitudes
4. Falls back to ellipsoid height for higher altitudes
5. Formats the height with appropriate units
6. Displays the height with a visual indicator

## Advanced Techniques

### Handling Different Terrain Providers

Different terrain providers may have varying levels of detail and accuracy. If your application switches between terrain providers, you'll need to update your height calculations accordingly:

```javascript
// Listen for terrain provider changes
let currentTerrainProvider = viewer.terrainProvider;
viewer.terrainProviderChanged.addEventListener(() => {
  currentTerrainProvider = viewer.terrainProvider;
  // Recalculate height with new terrain provider
  updateHeightAboveTerrain();
});
```

### Customizing Terrain Sampling

For more control over terrain sampling, you can use different sampling functions:

- `sampleTerrain`: Samples terrain at a specified level of detail
- `sampleTerrainMostDetailed`: Samples terrain at the highest available level of detail

```javascript
// Sample at a specific level of detail (faster but less accurate)
const level = 12; // Level of detail (0-15 typically)
Cesium.sampleTerrain(terrainProvider, level, [samplePosition])
  .then(updatedPositions => {
    const terrainHeight = updatedPositions[0].height;
    // Use the terrain height...
  });
```

### Handling Edge Cases

When working with camera height, consider these edge cases:

1. **Underground camera**: If the camera is below the terrain, the height above terrain will be negative
2. **No terrain data**: Some areas might not have terrain data, resulting in undefined heights
3. **Terrain loading**: Terrain data might still be loading when you sample it

Here's how to handle these cases:

```javascript
Cesium.sampleTerrainMostDetailed(terrainProvider, [samplePosition])
  .then(updatedPositions => {
    const terrainHeight = updatedPositions[0].height;
    
    // Handle underground camera
    const heightAboveTerrain = cameraPosition.height - terrainHeight;
    const clampedHeight = Math.max(0, heightAboveTerrain);
    
    updateHeightDisplay(clampedHeight);
  })
  .catch(error => {
    console.warn('Error sampling terrain:', error);
    // Fall back to ellipsoid height
    updateHeightDisplay(cameraPosition.height);
  });
```

## Real-World Example: Flight Simulator Altimeter

Let's look at a practical example: implementing an altimeter for a flight simulator application:

```javascript
class FlightSimulator {
  constructor(cesiumContainer) {
    this.viewer = new Cesium.Viewer(cesiumContainer, {
      terrainProvider: Cesium.createWorldTerrain()
    });
    
    this.altimeterElement = document.getElementById('altimeter');
    this.radarAltimeterElement = document.getElementById('radar-altimeter');
    
    // Set up camera change listener
    this.viewer.camera.percentageChanged = 0.01;
    this.viewer.camera.changed.addEventListener(() => this.updateAltimeters());
    
    // Initial update
    this.updateAltimeters();
  }
  
  updateAltimeters() {
    const cameraPosition = this.viewer.camera.positionCartographic;
    
    // Update barometric altimeter (height above ellipsoid)
    const barometricAltitude = Math.round(cameraPosition.height);
    this.altimeterElement.textContent = `${barometricAltitude} m`;
    
    // Update radar altimeter (height above terrain)
    if (cameraPosition.height < 5000) {
      // Only show radar altitude at lower heights
      const terrainProvider = this.viewer.terrainProvider;
      const samplePosition = new Cesium.Cartographic(
        cameraPosition.longitude,
        cameraPosition.latitude,
        0
      );
      
      Cesium.sampleTerrainMostDetailed(terrainProvider, [samplePosition])
        .then(updatedPositions => {
          const terrainHeight = updatedPositions[0].height;
          const radarAltitude = Math.max(0, Math.round(cameraPosition.height - terrainHeight));
          
          // Change color based on altitude
          if (radarAltitude < 100) {
            this.radarAltimeterElement.style.color = 'red';
          } else {
            this.radarAltimeterElement.style.color = 'white';
          }
          
          this.radarAltimeterElement.textContent = `${radarAltitude} m AGL`;
        });
    } else {
      this.radarAltimeterElement.textContent = '-- m AGL';
    }
  }
}

// Initialize the simulator
const simulator = new FlightSimulator('cesiumContainer');
```

This example shows how to implement both a barometric altimeter (showing height above ellipsoid) and a radar altimeter (showing height above ground level).

## Summary

Getting camera height in Cesium.js involves understanding the difference between ellipsoid height and height above terrain. The basic approach is:

1. Access the camera's position using `viewer.camera.positionCartographic`
2. For simple applications, use `positionCartographic.height` directly
3. For more accurate terrain-relative height:
   - Sample the terrain at the camera's position using `sampleTerrainMostDetailed`
   - Calculate the difference between camera height and terrain height
4. Optimize performance by:
   - Using different methods based on altitude
   - Throttling updates with `percentageChanged`
   - Handling edge cases appropriately

By following these techniques, you can accurately retrieve and display camera height in your Cesium.js applications, enhancing the user experience with meaningful altitude information.

Whether you're building a flight simulator, a terrain analysis tool, or any other 3D geospatial application, understanding camera height is a fundamental skill that opens up many possibilities for interactive and informative visualizations.