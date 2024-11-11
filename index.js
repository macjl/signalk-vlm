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

        values = [{
            path: 'navigation.position',
            value: {
              'longitude': resBody.LON / 1000,
              'latitude': resBody.LAT / 1000,
            }
          },
          {
            path: 'navigation.speedOverGround',
            value: resBody.BSP / 1.943844,
          },
					{
            path: 'navigation.speedTroughWater',
            value: resBody.BSP / 1.943844,
          },
          {
            path: 'navigation.courseOverGroundTrue',
            value: resBody.HDG / 57.29578,
          },
          {
            path: 'navigation.headingTrue',
            value: resBody.HDG / 57.29578,
          },
          {
            path: 'environment.wind.speedTrue',
            value: resBody.TWS / 1.943844,
          },
					{
            path: 'environment.wind.speedThroughWater',
            value: resBody.TWS / 1.943844,
          },
          {
            path: 'environment.wind.directionTrue',
            value: resBody.TWD / 57.29578,
          },
          {
            path: 'environment.wind.angleTrueGround',
            value: resBody.TWA / 57.29578,
          },
					{
            path: 'environment.wind.angleTrueWater',
            value: resBody.TWA / 57.29578,
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
