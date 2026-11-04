# -*- coding: utf-8 -*-
"""Download the generated application to LOCAL Control Win, start it and create boot app.

Uses documented ScriptOnline / ScriptDeviceObject APIs from installed SP22 stubs.
OnlineChangeOption.Never performs the download as part of login (there is no
ScriptOnlineApplication.download() method in this API).
"""
import io
import json
import os
import traceback
from scriptengine import *

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, 'build')
PROJECT = os.path.join(HERE, 'ayran.project')


def main():
    if not os.path.isdir(BUILD):
        os.makedirs(BUILD)
    result = {'success': False, 'host': '127.0.0.1', 'stage': 'open'}
    project = None
    try:
        with io.open(os.path.join(BUILD, 'build-result.json'), encoding='utf-8') as stream:
            build = json.load(stream)
        if not build.get('success'):
            raise RuntimeError('create_project.py must complete successfully before download')
        if projects.primary:
            projects.primary.close()
        project = projects.open(PROJECT)
        devices = [o for o in project.get_children(True) if o.is_device]
        apps = [o for o in project.get_children(True) if o.is_application]
        if len(devices) != 1 or len(apps) != 1:
            raise RuntimeError('Expected one device and one Application')
        device, app = devices[0], apps[0]
        project.active_application = app
        result['stage'] = 'gateway'
        gateway_name = os.environ.get('CODESYS_GATEWAY')
        local = []
        for gateway in online.gateways:
            if gateway_name and gateway.name != gateway_name:
                continue
            values = [str(v).lower() for v in gateway.config_params.values()]
            if any(v in ('localhost', '127.0.0.1', '::1') for v in values):
                local.append(gateway)
        all_gw = list(online.gateways)
        with io.open(os.path.join(BUILD, 'gateways.txt'), 'w', encoding='utf-8') as stream:
            for g in all_gw:
                stream.write(u'%s %s\n' % (g.name, dict(g.config_params)))
        if not all_gw and not gateway_name:
            # hiç ağ geçidi tanımlı değil (IDE'de cihaz taraması yapılmamış): yerel varsayılanı ekle
            gw = online.gateways.add_new_gateway('Gateway-1', {'IP-Address': 'localhost', 'Port': 1217})
            all_gw = [gw]
            with io.open(os.path.join(BUILD, 'gateways.txt'), 'a', encoding='utf-8') as stream:
                stream.write(u'eklendi: %s %s\n' % (gw.name, dict(gw.config_params)))
        if not local and not gateway_name and len(all_gw) >= 1:
            local = [all_gw[0]]   # varsayılan kurulum: tek ağ geçidi (Gateway-1) bu makinede
        if len(local) != 1:
            raise RuntimeError('Expected one configured localhost gateway; set CODESYS_GATEWAY if ambiguous')
        gateway = local[0]
        result['gateway'] = gateway.name
        # This resolves a CODESYS router address through the local gateway, not a Modbus address.
        address = gateway.find_address_by_ip('127.0.0.1')
        scan = list(gateway.perform_network_scan())
        with io.open(os.path.join(BUILD, 'gateways.txt'), 'a', encoding='utf-8') as stream:
            stream.write(u'adres(127.0.0.1): %s\n' % (address,))
            for t in scan:
                stream.write(u'tarama: %s | %s | %s\n' % (t.device_name, t.address, t.device_id.version))
        targets = [t for t in scan if str(t.address) == str(address)]
        if not targets and len(scan) == 1:
            targets = scan          # bu makinede tek çalışma ortamı var
        if targets:
            address = targets[0].address
        expected = device.get_device_identification()
        if len(targets) != 1:
            raise RuntimeError('Local runtime not uniquely identified by gateway scan')
        actual = targets[0].device_id
        result['runtime'] = {'name': targets[0].device_name, 'type': actual.type, 'id': actual.id, 'version': actual.version}
        # aynı kimlik farklı yazılır: id '4' ~ '0000 0004'; sürüm 50665000 (0x03051628) ~ '3.5.22.40'
        def norm_id(v):
            return int(str(v).replace(' ', ''), 16)
        def norm_ver(v):
            s = str(v)
            if '.' in s:
                p = [int(x) for x in s.split('.')]
                return (p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]
            return int(s)
        if (int(actual.type), norm_id(actual.id), norm_ver(actual.version)) != \
                (int(expected.type), norm_id(expected.id), norm_ver(expected.version)):
            raise RuntimeError('Local runtime identification does not match project target: ' + str(result['runtime']))
        device.set_gateway_and_address(gateway, address)
        device.set_simulation_mode(False)
        project.save()
        username = os.environ.get('CODESYS_USER')
        if username:
            online.set_default_credentials(username, os.environ.get('CODESYS_PASSWORD', ''))
        result['stage'] = 'login-download'
        with online.create_online_application(app) as application:
            application.login(OnlineChangeOption.Never, False)
            if not application.is_logged_in:
                raise RuntimeError('Login/download failed')
            result['stage'] = 'start'
            application.start()
            system.delay(500)
            result['state'] = str(application.application_state)
            if application.application_state != ApplicationState.run:
                raise RuntimeError('Application did not enter RUN: ' + result['state'])
            result['stage'] = 'boot'
            application.create_boot_application()
            application.logout()
        project.save()
        result['stage'] = 'complete'
        result['success'] = True
    except:
        result['exception'] = traceback.format_exc()
    finally:
        # mesajlar Türkçe olabilir: JSON'a değil UTF-8 metin dosyasına
        with io.open(os.path.join(BUILD, 'download-messages.txt'), 'w', encoding='utf-8') as stream:
            for category in system.get_message_categories():
                for message in system.get_message_objects(category):
                    stream.write(u'[%s] %s\n' % (str(message.severity), message.text))
            if 'exception' in result:
                stream.write(u'\n' + result['exception'])
                result['exception'] = 'download-messages.txt'
        with io.open(os.path.join(BUILD, 'download-result.json'), 'w', encoding='utf-8') as stream:
            stream.write(unicode(json.dumps(result, ensure_ascii=True, indent=2)))
        if project is not None:
            project.close()
    print('CODESYS download/RUN/boot success: ' + str(result['success']))
    system.exit(0 if result['success'] else 1)


main()
