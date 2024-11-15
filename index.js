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
  const version = '0.5.1'
  var plugin = {};
  var dataGet, dataPublish;
  var LAT, LON, SOG, COG, TWS, TWD, TWA, LOG, AWA, AWS, PIM, PIT, timestamp;

  plugin.id = "signalk-vlm";
  plugin.name = "VLM";
  plugin.description = "Plugin to gather virtual boat informations from https://www.v-l-m.org";

  plugin.schema = {
    type: 'object',
    required: ['login', 'password', 'boatid'],
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
      boatid: {
        type: "number",
        title: "Boat ID"
      },
    }
  }

  plugin.start = function(options) {
    if ((!options.login) || (!options.password) || (!options.boatid)) {
      app.error('Login, password and boat# are required')
      return;
    }

    const basicauth = btoa(options.login + ':' + options.password);

    const degToRad = deg => (deg * Math.PI) / 180.0;

    const knToMs = kn => (kn * 0.51444);

    const nMToM = nm => (nm * 1852 );

    const getBoatInfo = async (options = {}) => {
      app.debug('Get vBoat informations');
      const res = await fetch('https://www.v-l-m.org/ws/boatinfo.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + basicauth,
	  'User-Agent': 'signalk-vlm/' + version,
        },
        body: new URLSearchParams({
          forcefmt: 'json',
          select_idu: options.boatid,
        }).toString()
      });
      if (!res.ok) {
        app.error(`Failed to get boat info from VLM: HTTP ${res.status} ${res.statusText}`);
      } else {
        const resBody = await res.json();
        app.debug(`Received: ${JSON.stringify(resBody)}`);

	timestamp = Date.now();
	LAT = resBody.LAT / 1000;
	LON = resBody.LON / 1000;
	SOG = knToMs( resBody.BSP );
	COG = degToRad( resBody.HDG );
	TWS = knToMs( resBody.TWS );
	TWD = degToRad( resBody.TWD );
        // Correct the TWA Bug
	//TWA = degToRad( resBody.TWA );
	TWA = degToRad( ( 180 + resBody.TWD - resBody.HDG) % 360 -180 );
	LOG = nMToM( resBody.LOC );
        AWA = Math.atan( TWS * Math.sin( TWA ) /( SOG + TWS * Math.cos( TWA ) ));
        AWS = Math.sqrt( Math.pow(TWS * Math.sin( TWA ), 2) + Math.pow( SOG + TWS * Math.cos( TWA ), 2 ) );
	PIM = resBody.PIM;
	if (( PIM == 1 ) || ( PIM == 2 )) {
	  PIT = degToRad(resBody.PIP);
	}

        app.handleMessage(plugin.id, {
          updates: [{
            values: [{ path: 'name', value: resBody.IDB }]
          }]
        });

      }
    }

    const actualPos = () => {
      const dist = SOG * (Date.now() - timestamp) / 1000 / 1852
      const dlat = dist / 60 * Math.cos(COG);
      const dlon = dist / 60 * Math.sin(COG) / Math.cos(degToRad(LAT));
      return { 'latitude': LAT + dlat, 'longitude': LON + dlon }
    }

    const actualTripLog = () => {
      const dlog = SOG * (Date.now() - timestamp) / 1000
      return LOG + dlog
    }

    const piParms = () => {
      let piparms = [];

      if ( PIM == 1 )
        piparms = piparms.concat( [
	  { path: 'steering.autopilot.state', value: "auto" },
	  { path: 'steering.autopilot.target.headingTrue', value: PIT }
	]);
      else if ( PIM == 2 )
        piparms = piparms.concat( [
	  { path: 'steering.autopilot.state', value: "wind" },
          { path: 'steering.autopilot.target.windAngleTrueGround', value: - PIT }
	]);
      else if ( PIM == 3 )
        piparms = piparms.concat( [
	  { path: 'steering.autopilot.state', value: "track" },
	]);
      else if ( PIM == 4 )
        piparms = piparms.concat( [
	  { path: 'steering.autopilot.state', value: "vmg" },
	]);
      else if ( PIM == 5 )
        piparms = piparms.concat( [
	  { path: 'steering.autopilot.state', value: "vbvmg" },
	]);

      return piparms
    }

    const publishBoatInfo = () => {
      let values = [{
          path: 'navigation.position', value: actualPos()
        },{
          path: 'navigation.speedOverGround', value: SOG
        },{
          path: 'navigation.courseOverGroundTrue', value: COG
        },{
          path: 'environment.wind.speedTrue', value: TWS
        },{
          path: 'environment.wind.directionTrue', value: TWD
        },{
          path: 'environment.wind.angleTrueGround', value: TWA
        },{
          path: 'navigation.trip.log', value: actualTripLog() 
        },{
          path: 'environment.wind.angleApparent', value: AWA
        },{
          path: 'environment.wind.speedApparent', value: AWS
        }];
      values = values.concat(piParms());

      app.handleMessage(plugin.id, {
        updates: [{
          values: values
        }]
      });
    }

    getBoatInfo();
    dataGet = setInterval( getBoatInfo, 300 * 1000 );
    dataPublish = setInterval( publishBoatInfo, 1 * 1000);
  }

  plugin.stop = function() {
    clearInterval(dataGet);
    clearInterval(dataPublish);
    app.setPluginStatus('Pluggin stopped');
  };

  return plugin;
}
