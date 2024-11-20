/*
 * Copyright 2024 Jean-Laurent Girod <jeanlaurent.girod@icloud.com>
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


module.exports = function(app) {
    const version = '0.6.0'
    var plugin = {};
    var dataGet, dataPublish, dataGetOther, dataPublishOther;
    var MMSI, LAT, LON, SOG, COG, TWS, TWD, TWA, LOG, AWA, AWS, PIM, PIT, WPLON, WPLAT, timestamp;
    var RAC,IDU=0;
    let unsubscribes = [];
    let otherBoats = [];

    plugin.id = "signalk-vlm";
    plugin.name = "VLM";
    plugin.description = "Plugin to gather virtual boat informations from https://www.v-l-m.org";

    plugin.schema = {
      type: 'object',
      required: ['login', 'password'],
      description: 'Warning! In order not to overload the servers of https://www.v-l-m.org, only activate this plugin when you use it.',
      properties: {
        login: {
          type: "string",
          title: "Login"
        },
        password: {
          type: "string",
          title: "Password"
        },
        setwp: {
          type: "boolean",
          title: "Set the VLM Wapypoint (experimental)",
          default: false
        },
        ais: {
          type: "boolean",
          title: "Show other boats in race as AIS target",
          default: false
        }
      }
    }

    plugin.start = async function(options) {
      if ((!options.login) || (!options.password)) {
        app.error('Login, password and boat# are required')
        return;
      }

      // Fonction pour calculer la distance entre deux positions GPS
      function haversineDistance(lat1, lon1, lat2, lon2) {
        const dLat = degToRad(lat2 - lat1);
        const dLon = degToRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(degToRad(lat1)) * Math.cos(degToRad(lat2)) *
          Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return 6371000 * c; // distance en mètres
      }

      // Fonction pour calculer le COG (Course Over Ground)
      function calculateCOG(lat1, lon1, lat2, lon2) {
        const dLon = degToRad(lon2 - lon1);
        const y = Math.sin(dLon) * Math.cos(degToRad(lat2));
        const x = Math.cos(degToRad(lat1)) * Math.sin(degToRad(lat2)) -
          Math.sin(degToRad(lat1)) * Math.cos(degToRad(lat2)) * Math.cos(dLon);
        let cog = Math.atan2(y, x); // COG en radians
        if (cog < 0) {
          cog += 2 * Math.PI ;
        }
        return cog; // COG en rad
      }

      // Fonction pour calculer le SOG (Speed Over Ground)
      function calculateSOG(distance, timeInSeconds) {
        const sog = distance / timeInSeconds * 1000; // SOG en m/s
        return sog ;
      }

      const basicauth = btoa(options.login + ':' + options.password);

      const degToRad = deg => (deg * Math.PI) / 180.0;

      const knToMs = kn => (kn * 0.51444);

      const nMToM = nm => (nm * 1852);

      const registerWpPath = () => {
        app.debug("Registering to paths to set WP in VLM");
        let localSubscription = {
          context: '*',
          subscribe: [{
            path: 'navigation.course*.nextPoint.position',
            period: 1000
          }]
        };
        app.subscriptionmanager.subscribe(
          localSubscription,
          unsubscribes,
          subscriptionError => {
            app.error('Error:' + subscriptionError);
          },
          delta => {
            delta.updates.forEach(u => {
              if ( u.$source != "signalk-vlm" ) {
                let wptarget=u["values"][0]["value"];
                let sWPLAT = wptarget["latitude"].toFixed(7);
                let sWPLON = wptarget["longitude"].toFixed(7);
                setBoatWP(sWPLAT, sWPLON);
              }
            });
          }
        );
      }

      const setBoatWP = async ( sWPLAT, sWPLON) => {
        app.debug("New WP Target received from SignalK: " + sWPLAT + "," + sWPLON);
        if ( ( sWPLAT == WPLAT ) && ( sWPLON == WPLON ) ) {
          app.debug('Same waypoint already set');
        } else if ( ( PIM == undefined ) || ( PIM < 3 ) ) {
          app.debug('Pilote mode should be Ortho, VMG or VBMG to set waypoint')
        } else {
          let parms = "{\"pip\":{\"targetlat\":" + sWPLAT + ",\"targetlong\":" + sWPLON + ",\"targetandhdg\":-1},\"idu\":\"" + IDU + "\"}";
          app.debug( 'New waypoint to VLM: ' + parms );
          const res = await fetch('https://www.v-l-m.org/ws/boatsetup/target_set.php', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Authorization': 'Basic ' + basicauth,
              'User-Agent': 'signalk-vlm/' + version,
            },
            body: new URLSearchParams({
              forcefmt: 'json',
              select_idu: IDU,
              parms: parms,
            }).toString()
          });
          if (!res.ok) {
            app.error(`Failed to set boat WP to VLM: HTTP ${res.status} ${res.statusText}`);
          } else {
            const resBody = await res.json();
            app.debug(`Received: ${JSON.stringify(resBody)}`);
            if ( resBody.success == true ) {
              WPLON = sWPLON;
              WPLAT = sWPLAT;
              sWPLON = undefined;
              sWPLAT = undefined;
              getBoatInfo();
            } else {
              app.error(`Error setting waypoint: ${JSON.stringify(resBody)}`);
            }
          }
        }
      }

      const getBoatInfo = async () => {
        app.debug('Start Get vBoat informations routine');
        const res = await fetch('https://www.v-l-m.org/ws/boatinfo.php', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + basicauth,
            'User-Agent': 'signalk-vlm/' + version,
          },
          body: new URLSearchParams({
            forcefmt: 'json',
            select_idu: IDU,
          }).toString()
        });
        if (!res.ok) {
          app.error(`Failed to get boat info from VLM: HTTP ${res.status} ${res.statusText}`);
        } else {
          const resBody = await res.json();
          app.debug(`Received: ${JSON.stringify(resBody)}`);

          timestamp = Date.now();
          IDU = resBody.IDU;
          MMSI = (999999999 - IDU).toString();
          RAC = resBody.RAC;
          LAT = resBody.LAT / 1000;
          LON = resBody.LON / 1000;
          SOG = knToMs(resBody.BSP);
          COG = degToRad(resBody.HDG);
          TWS = knToMs(resBody.TWS);
          TWD = degToRad(resBody.TWD);
          // Correct the TWA Bug
          //TWA = degToRad( resBody.TWA );
          TWA = degToRad((180 + resBody.TWD - resBody.HDG) % 360 - 180);
          LOG = nMToM(resBody.LOC);
          AWA = Math.atan(TWS * Math.sin(TWA) / (SOG + TWS * Math.cos(TWA)));
          AWS = Math.sqrt(Math.pow(TWS * Math.sin(TWA), 2) + Math.pow(SOG + TWS * Math.cos(TWA), 2));
          PIM = resBody.PIM;
          if ((PIM == 1) || (PIM == 2)) {
            PIT = degToRad(resBody.PIP);
          } else {
            WPLAT = resBody.PIP.split("@")[0].split(",")[0];
            WPLON = resBody.PIP.split("@")[0].split(",")[1];
          }

          app.handleMessage(plugin.id, {
            updates: [{
              values: [{
                path: '',
                value: {name: resBody.IDB}
              }]
            }]
          });
        }
      }

      const getOtherBoats = async () => {
        app.debug('Start Get Other vBoat informations routine');
        const res = await fetch('https://www.v-l-m.org/ws/raceinfo/ranking.php', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + basicauth,
            'User-Agent': 'signalk-vlm/' + version,
          },
          body: new URLSearchParams({
            forcefmt: 'json',
            idr: RAC,
          }).toString()
        });
        if (!res.ok) {
          app.error(`Failed to get other boat info from VLM: HTTP ${res.status} ${res.statusText}`);
        } else {
          const resBody = await res.json();
          ranks = resBody.ranking;
          //app.debug(`Received: ${JSON.stringify(ranks)}`);
          for (var rank in ranks) {
            const ts = Date.now();
            const boatname = ranks[rank].boatname;
            const latitude = ranks[rank].latitude;
            const longitude = ranks[rank].longitude;
            const country = ranks[rank].country.toString();
            const loch = nMToM(ranks[rank].loch);
            const mmsi = (999999999 - rank ).toString();
            var cog,sog;
            if (otherBoats[mmsi] != undefined) {
              const distance = haversineDistance(otherBoats[mmsi].latitude, otherBoats[mmsi].longitude, latitude, longitude);
              cog = calculateCOG(otherBoats[mmsi].latitude, otherBoats[mmsi].longitude, latitude, longitude);
              sog = calculateSOG(distance, ts - otherBoats[mmsi].ts);
            } else {
              sog = SOG;
              cog = COG;
            }
            otherBoats[mmsi] = {
              name: boatname,
              latitude: latitude,
              longitude: longitude,
              flag: country,
              trip: loch,
              mmsi: mmsi,
              cog: cog,
              sog: sog,
              ts: ts,
            };
          }
        }
      }

      const publishOtherBoats = () => {
          for ( var boat in otherBoats ) {
            if ( boat != MMSI ) {
              app.handleMessage(plugin.id, {
                context: 'vessels.urn:mrn:signalk:uuid:' + otherBoats[boat].mmsi,
                updates: [{
                  values:
                    [{
                      path: 'sensors.ais.class',
                      value: "B",
                    },{
                      path: 'navigation.speedOverGround',
                      value: otherBoats[boat].sog,
                    },{
                      path: 'navigation.courseOverGroundTrue',
                      value: otherBoats[boat].cog,
                    },{
                      path: '',
                      value: { name: otherBoats[boat].name},
                    },{
                      path: '',
                      value: { mmsi: otherBoats[boat].mmsi },
                    },{
                      path: 'navigation.trip.log',
                      value: otherBoats[boat].trip,
                    },{
                      path: '',
                      value: { flag: otherBoats[boat].flag }
                    },{
                      path: 'navigation.position',
                      value: {
                        latitude: otherBoats[boat].latitude,
                        longitude: otherBoats[boat].longitude,
                      }
                  }]
                }]
              });
            }
          }
      }

      const actualPos = () => {
        const dist = SOG * (Date.now() - timestamp) / 1000 / 1852
        const dlat = dist / 60 * Math.cos(COG);
        const dlon = dist / 60 * Math.sin(COG) / Math.cos(degToRad(LAT));
        return {
          'longitude': LON + dlon,
          'latitude': LAT + dlat,
        }
      }

      const actualTripLog = () => {
        const dlog = SOG * (Date.now() - timestamp) / 1000
        return LOG + dlog
      }

      const piParms = () => {
        let piparms = [];

        if (PIM == 1)
          piparms = piparms.concat([{
              path: 'steering.autopilot.state',
              value: "auto"
            },
            {
              path: 'steering.autopilot.target.headingTrue',
              value: PIT
            }
          ]);
        else if (PIM == 2)
          piparms = piparms.concat([{
              path: 'steering.autopilot.state',
              value: "wind"
            },
            {
              path: 'steering.autopilot.target.windAngleTrueGround',
              value: -PIT
            }
          ]);
        else if (PIM == 3)
          piparms = piparms.concat([{
            path: 'steering.autopilot.state',
            value: "track"
          }, ]);
        else if (PIM == 4)
          piparms = piparms.concat([{
            path: 'steering.autopilot.state',
            value: "vmg"
          }, ]);
        else if (PIM == 5)
          piparms = piparms.concat([{
            path: 'steering.autopilot.state',
            value: "vbvmg"
          }, ]);

        if (PIM > 2) {
          let pos = {
            'longitude': WPLON,
            'latitude': WPLAT,
          }
          piparms = piparms.concat([{
            path: 'navigation.courseGreatCircle.nextPoint.position',
            value: pos,
          }, ]);
        }
        return piparms
      }

      const publishBoatInfo = () => {
        let values = [{
          path: '',
          value: { mmsi: MMSI }
        }, {
          path: 'navigation.position',
          value: actualPos()
        }, {
          path: 'navigation.speedOverGround',
          value: SOG
        }, {
          path: 'navigation.courseOverGroundTrue',
          value: COG
        }, {
          path: 'environment.wind.speedTrue',
          value: TWS
        }, {
          path: 'environment.wind.directionTrue',
          value: TWD
        }, {
          path: 'environment.wind.angleTrueGround',
          value: TWA
        }, {
          path: 'navigation.trip.log',
          value: actualTripLog()
        }, {
          path: 'environment.wind.angleApparent',
          value: AWA
        }, {
          path: 'environment.wind.speedApparent',
          value: AWS
        }];
        values = values.concat(piParms());

        app.handleMessage(plugin.id, {
          updates: [{
            values: values
          }]
        });
      }

      await getBoatInfo();
      publishBoatInfo();
      dataGet = setInterval(getBoatInfo, 300 * 1000);
      dataPublish = setInterval(publishBoatInfo, 1 * 1000);

      if (options.ais){
        await getOtherBoats();
        publishOtherBoats();
        dataGetOther = setInterval(getOtherBoats, 300 * 1000);
        dataPublishOther = setInterval(publishOtherBoats, 15 * 1000);
      }

      if (options.setwp){
        registerWpPath();
      }
    }

    plugin.stop = function() {
      clearInterval(dataGet);
      clearInterval(dataGetOther);
      clearInterval(dataPublish);
      clearInterval(dataPublishOther);
      unsubscribes.forEach(f => f());
      unsubscribes = [];
      app.setPluginStatus('Pluggin stopped');
    };

    return plugin;
}
