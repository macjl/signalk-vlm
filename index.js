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
  var plugin = {};
  var dataGet;
  var dataPublish;
  var values = [];

  plugin.id = "signalk-vlm";
  plugin.name = "VLM";
  plugin.description = "Plugin to gather virtual boat informations from https://www.v-l-m.org";

  plugin.schema = {
    type: 'object',
    required: ['login', 'password', 'boatid'],
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

    const getBoatInfo = async (options = {}) => {
      app.debug('Get vBoat informations');
      const res = await fetch('https://www.v-l-m.org/ws/boatinfo.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + basicauth,
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
	
	let TWA = degToRad( resBody.TWA );
	let HDG = degToRad( resBody.HDG );
	let TWD = degToRad( resBody.TWD );
	let SOG = knToMs( resBody.BSP );
	let TWS = knToMs( resBody.TWS );

        let AWA = Math.atan( TWS * Math.sin( TWA ), SOG + TWS * Math.cos( TWA ) );
	let AWS = Math.sqrt( ( TWS * Math.sin( TWA ) )^2 + ( SOG + TWS * Math.cos( TWA ) )^2 );

        values = [{
            path: 'navigation.position',
            value: {
              'longitude': resBody.LON / 1000,
              'latitude': resBody.LAT / 1000,
            }
          },
          {
            path: 'navigation.speedOverGround',
            value: SOG,
          },
	  {
            path: 'navigation.speedThroughWater',
            value: SOG,
          },
          {
            path: 'navigation.courseOverGroundTrue',
            value: HDG,
          },
          {
            path: 'navigation.headingTrue',
            value: HDG,
          },
          {
            path: 'environment.wind.speedTrue',
            value: TWS,
          },
					{
            path: 'environment.wind.speedThroughWater',
            value: TWS,
          },
          {
            path: 'environment.wind.directionTrue',
            value: TWD,
          },
          {
            path: 'environment.wind.angleTrueGround',
            value: TWA,
          },
					{
            path: 'environment.wind.angleTrueWater',
            value: TWA,
          },
          {
            path: 'environment.wind.angleApparent',
            value: AWA,
          },
          {
            path: 'environment.wind.speedApparent',
            value: AWS,
          },
        ]
      }
    }


    dataGet = setInterval(function() {
      getBoatInfo();
    }, 60 * 1000);

    getBoatInfo();

    dataPublish = setInterval(function() {
      app.handleMessage(plugin.id, {
        updates: [{
          values: values
        }]
      });
    }, 1 * 1000);

  }

  plugin.stop = function() {
    clearInterval(dataGet);
    clearInterval(dataPublish);
    app.setPluginStatus('Pluggin stopped');
  };

  return plugin;
}
