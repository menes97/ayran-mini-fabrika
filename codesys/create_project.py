# -*- coding: utf-8 -*-
"""Run with CODESYS --runscript=".../create_project.py" --noUI.

API reference: installed ScriptLib/Stubs/scriptengine/*.pyi (SP22 Patch 4).
No Python 3 features: this runs inside the CODESYS IronPython 2.7 engine.
"""
import io
import json
import os
import shutil
import traceback
import xml.etree.ElementTree as ET
from scriptengine import *

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, 'build')
PROJECT = os.path.join(HERE, 'ayran.project')
DATA = os.path.join(os.environ.get('PROGRAMDATA', r'C:\ProgramData'), 'CODESYS')
DEVICE_VERSION = '3.5.22.40'
LIB_VERSION = '4.5.0.0'


def write_json(filename, value):
    with io.open(os.path.join(BUILD, filename), 'w', encoding='utf-8') as stream:
        stream.write(unicode(json.dumps(value, ensure_ascii=True, indent=2)))


def child_text(element, name):
    for child in element:
        if child.tag.rsplit('}', 1)[-1] == name:
            return child.text
    raise RuntimeError('Missing XML field: ' + name)


def installed_device():
    # Read the device repository; never substitute a similar Win/Win SL target.
    matches = []
    for folder, dirs, files in os.walk(os.path.join(DATA, 'Devices')):
        if 'device.xml' not in files:
            continue
        filename = os.path.join(folder, 'device.xml')
        with io.open(filename, encoding='utf-8-sig') as stream:
            if 'CODESYS Control Win V3 x64' not in stream.read():
                continue
        tree = ET.parse(filename)
        info = None
        ident = None
        for element in tree.iter():
            tag = element.tag.rsplit('}', 1)[-1]
            if tag == 'DeviceInfo':
                info = element
            elif tag == 'DeviceIdentification':
                ident = element
        if info is not None and ident is not None and child_text(info, 'Name') == 'CODESYS Control Win V3 x64':
            if child_text(ident, 'Version') == DEVICE_VERSION:
                matches.append({'name': child_text(info, 'Name'), 'type': int(child_text(ident, 'Type')),
                                'id': child_text(ident, 'Id'), 'version': child_text(ident, 'Version'), 'source': filename})
    if len(matches) != 1:
        raise RuntimeError('Expected one installed Control Win V3 x64 ' + DEVICE_VERSION + ': ' + str(matches))
    return matches[0]


def message_report():
    rows = []
    for category in system.get_message_categories():
        for message in system.get_message_objects(category):
            where = u''
            try:
                if message.object is not None:
                    where = u'%s @ %s' % (message.object.get_name(), message.position_text)
            except:
                where = u'?'
            rows.append({'severity': str(message.severity), 'text': message.text, 'where': where})
    with io.open(os.path.join(BUILD, 'build-messages.txt'), 'w', encoding='utf-8') as stream:
        for row in rows:
            stream.write(u'[%s] %s | %s\n' % (row['severity'], row['text'], row['where']))
    return rows


def main():
    if not os.path.isdir(BUILD):
        os.makedirs(BUILD)
    result = {'success': False, 'stage': 'load', 'project': PROJECT}
    write_json('build-result.json', result)
    project = None
    try:
        with io.open(os.path.join(BUILD, 'pous.json'), encoding='utf-8') as stream:
            source = json.load(stream)
        if source['schemaVersion'] != 1 or source['role'] != 'tek':
            raise RuntimeError('Unsupported generated schema/role; run npm run build:codesys')
        device_id = installed_device()
        write_json('build-result.json', dict(result, stage='device-found'))
        result['device'] = device_id
        library_file = os.path.join(DATA, 'Managed Libraries', 'CODESYS', 'ModbusFB', LIB_VERSION, 'ModbusFB.compiled-library-v3')
        if not os.path.isfile(library_file):
            raise RuntimeError('Missing installed ModbusFB: ' + library_file)
        standard_root = os.path.join(DATA, 'Managed Libraries', 'System', 'Standard')
        standard_versions = [v for v in os.listdir(standard_root)
                             if os.path.isdir(os.path.join(standard_root, v)) and len(v.split('.')) == 4]
        standard_version = max(standard_versions, key=lambda v: tuple(int(n) for n in v.split('.')))
        result['libraries'] = ['Standard, ' + standard_version + ' (System)', 'ModbusFB, ' + LIB_VERSION + ' (CODESYS)']
        if projects.primary:
            projects.primary.close()
        if os.path.isfile(PROJECT):
            shutil.copy2(PROJECT, os.path.join(BUILD, 'ayran.previous.project'))
        result['stage'] = 'create'
        write_json('build-result.json', result)
        project = projects.create(PROJECT)
        project.add('Device', device_id['type'], device_id['id'], device_id['version'])
        applications = [o for o in project.get_children(True) if o.is_application]
        if len(applications) != 1:
            raise RuntimeError('Device did not create exactly one Application')
        app = applications[0]
        project.active_application = app
        manager = app.get_library_manager()
        lib_log = []
        for library in result['libraries']:
            found = librarymanager.find_library(library)
            if found is not None:
                manager.add_library(found[0])
                lib_log.append(u'nesne: ' + library)
            elif library.startswith('Standard'):
                manager.add_placeholder('Standard', library)
                lib_log.append(u'yer tutucu: ' + library)
            else:
                manager.add_library(library)
                lib_log.append(u'ad: ' + library)
        lib_log.append(u'proje kutuphaneleri: ' + u', '.join([unicode(x) for x in manager.get_libraries()]))
        for ref in manager.references:
            try:
                qo = ref.qualified_only
                if ref.name.startswith('Standard') and qo:
                    ref.qualified_only = False
                lib_log.append(u'ref: %s yer_tutucu=%s nitelikli=%s' % (ref.name, ref.is_placeholder, qo))
            except Exception as e:
                lib_log.append(u'ref: %s (%s)' % (ref.name, e))
        with io.open(os.path.join(BUILD, 'libraries.txt'), 'w', encoding='utf-8') as stream:
            stream.write(u'\n'.join(lib_log))
        result['stage'] = 'pous'
        write_json('build-result.json', result)
        for pou in source['pous']:
            kind = pou['kind']
            if kind == 'PERSISTENT':
                obj = app.create_persistentvars(pou['name'])
            elif kind == 'GVL':
                obj = app.create_gvl(pou['name'])
            else:
                pou_type = PouType.FunctionBlock if kind == 'FUNCTION_BLOCK' else PouType.Program
                obj = app.create_pou(name=pou['name'], type=pou_type, language=ImplementationLanguages.st)
            obj.textual_declaration.replace(new_text=pou['declaration'])
            if pou['body']:
                obj.textual_implementation.replace(new_text=pou['body'])
            for action in pou.get('actions', []):
                obj.create_action(action['name'], ImplementationLanguages.st).textual_implementation.replace(new_text=action['body'])
        task_config = app.create_task_configuration()
        task = task_config.create_task(source['task']['name'])
        task.kind_of_task = KindOfTask.Cyclic
        task.priority = source['task']['priority']
        task.interval = source['task']['interval']
        for program in source['task']['programs']:
            task.pous.add(program)
        project.save()
        # kütüphane başvuruları ancak proje yeniden açılınca çözülüyor: kapat, aç, sonra derle
        project.close()
        project = projects.open(PROJECT)
        app = [o for o in project.get_children(True) if o.is_application][0]
        project.active_application = app
        manager = app.get_library_manager()
        result['stage'] = 'build'
        write_json('build-result.json', result)
        for category in system.get_message_categories():
            system.clear_messages(category)
        app.build()
        app.generate_code()
        rows = message_report()
        result['errors'] = len([r for r in rows if r['severity'] in ('Error', 'FatalError')])
        result['success'] = result['errors'] == 0
        result['stage'] = 'complete'
        result['resolved_libraries'] = len(manager.get_libraries(True))
        project.save()
    except:
        result['exception'] = traceback.format_exc()
        message_report()
    finally:
        write_json('build-result.json', result)
        if project is not None:
            project.close()
    print('CODESYS build success: ' + str(result['success']))
    system.exit(0 if result['success'] else 1)


main()
