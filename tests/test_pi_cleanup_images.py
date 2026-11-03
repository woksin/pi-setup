"""Dev-image age-out in pi-cleanup: hostile cases keep the image (fail closed), removal never forces."""
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
import unittest
from unittest.mock import patch

from test_pi_cleanup import cleanup

DAY = 86400


def stamp(days):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - days * DAY))


class Docker:
    """Fake docker/git. images: (id, tags, created_days, last_tag_days|raw string, digests)."""

    def __init__(self, images, containers=(), grep=(0, '', ''), inspect_rc=0):
        self.images, self.containers, self.grep = images, list(containers), grep
        self.calls, self.inspect_rc = [], inspect_rc
        self.ids = {tag: image[0] for image in images for tag in image[1]}

    def inspect_line(self, image):
        iid, tags, created, last, digests = image
        last = last if isinstance(last, str) else stamp(last)
        return f"{iid}|{stamp(created)}|{json.dumps(tags)}|100|{json.dumps(digests)}|{json.dumps(last)}"

    def __call__(self, cmd, **kwargs):
        self.calls.append(cmd)
        if cmd[:3] == ['docker', 'image', 'ls']:
            return 0, ''.join(i[0] + '\n' for i in self.images), ''
        if cmd[:2] == ['docker', 'ps']:
            return 0, ''.join(c[0] + '\n' for c in self.containers), ''
        if cmd[:2] == ['docker', 'inspect']:
            return 0, ''.join(f"{c[1]}|{c[2]}\n" for c in self.containers), ''
        if cmd[:3] == ['docker', 'image', 'inspect'] and cmd[3] == '-f' and cmd[4] == '{{.Id}}':
            return (0, self.ids.get(cmd[5], '') + '\n', '') if self.inspect_rc == 0 else (1, '', 'No such image')
        if cmd[:3] == ['docker', 'image', 'inspect']:
            return 0, ''.join(self.inspect_line(i) + '\n' for i in self.images), ''
        if cmd[:2] == ['docker', 'rmi']:
            return 0, 'Untagged', ''
        if cmd[:2] == ['git', 'grep']:
            return self.grep
        raise AssertionError(cmd)

    def rmis(self):
        return [c for c in self.calls if c[:2] == ['docker', 'rmi']]


class ImageCase(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(tmp, ignore_errors=True))
        self.state = tmp
        env = patch.dict(os.environ, DOCKER_GUARDIAN_STATE=str(tmp))
        env.start()
        self.addCleanup(env.stop)
        self.checkout = type('C', (), {'path': str(tmp), 'exists': True})()

    def plan(self, docker, pins=None, dev=2, checkouts=True, refs=None):
        if pins is not None:
            (self.state / 'pinned.txt').write_text(pins)
        if refs is None:
            with patch.object(cleanup, 'run', side_effect=docker):
                refs, error = cleanup.dockerfile_refs([self.checkout] if checkouts else [])
            refs = None if error else refs
        with patch.object(cleanup, 'run', side_effect=docker):
            return cleanup.plan_rmi(7, None, dev, refs)

    def ids(self, items):
        return [i['id'] for i in items]

    def image(self, tag='cratis/chronicle:19.114.0-development', created=30, last=3, iid='sha256:a', digests=()):
        return (iid, tag if isinstance(tag, list) else [tag], created, last, list(digests))


class DevImageTests(ImageCase):
    def test_a_unused_dev_tag_older_than_two_days_is_a_candidate(self):
        cands, kept, err = self.plan(Docker([self.image(created=3)]))
        self.assertIsNone(err)
        self.assertEqual(self.ids(cands), ['sha256:a'])
        self.assertTrue(cands[0]['dev'])

    def test_b_one_day_old_tag_is_kept(self):
        cands, kept, _ = self.plan(Docker([self.image(created=1, last=1)]))
        self.assertEqual((cands, kept), ([], []))

    def test_c_release_version_is_not_a_dev_candidate(self):
        cands, _, _ = self.plan(Docker([self.image('cratis/stage:4.210.2', created=3, last=3)]))
        self.assertEqual(cands, [])  # three days old: the 7-day general rule does not apply either

    def test_d_pinned_tag_is_kept(self):
        cands, kept, _ = self.plan(Docker([self.image('cratis/chronicle:l72-1265-baseline')]), 'cratis/chronicle:l72-*\n')
        self.assertEqual(cands, [])
        self.assertEqual(kept[0]['reason'], 'pinned: cratis/chronicle:l72-*')

    def test_e_used_by_id_or_by_name_is_absent(self):
        for container in (('c1', 'sha256:a', 'other'), ('c1', 'sha256:zzz', 'cratis/chronicle:19.114.0-development')):
            with self.subTest(container=container):
                cands, kept, _ = self.plan(Docker([self.image()], [container]))
                self.assertEqual((cands, kept), ([], []))

    def test_f_referenced_by_a_dockerfile_is_kept(self):
        docker = Docker([self.image('cratis/chronicle:19.112.1-development')],
                        grep=(0, 'cratis/chronicle:19.112.1-development\n', ''))
        cands, kept, _ = self.plan(docker)
        self.assertEqual(cands, [])
        self.assertEqual(kept[0]['reason'], 'referenced by Dockerfile/compose')

    def test_f2_registry_prefix_does_not_hide_a_reference(self):
        docker = Docker([self.image('cratis/chronicle:19.112.1-development')],
                        grep=(0, 'docker.io/cratis/chronicle:19.112.1-development\nghcr.io/cratis/x:1-dev\n', ''))
        self.assertEqual(self.plan(docker)[0], [])

    def test_g_failed_reference_scan_means_no_dev_candidates_but_general_rule_runs(self):
        for rc in (124, 128):
            with self.subTest(rc=rc):
                docker = Docker([self.image(created=3), self.image('mongo:7', created=30, last=30, iid='sha256:m')],
                                grep=(rc, '', 'boom'))
                with patch.object(cleanup, 'run', side_effect=docker):
                    refs, error = cleanup.dockerfile_refs([self.checkout])
                self.assertIn('repo reference scan failed', error)
                cands, _, _ = self.plan(docker, refs=None)
                self.assertEqual(self.ids(cands), ['sha256:m'])  # general 7-day rule only

    def test_g2_plan_docker_notes_a_failed_scan_and_never_removes_dev_images(self):
        ctx = cleanup.Ctx(cleanup.parse_args([]))
        ctx.docker_up = True
        ctx.checkouts = [self.checkout]
        docker = Docker([self.image(created=3)], grep=(128, '', 'fatal'))
        with patch.object(cleanup, 'run', side_effect=lambda cmd, **k: (0, '', '') if cmd[:2] == ['docker', 'system'] else docker(cmd, **k)):
            plan = cleanup.plan_docker(ctx)
        self.assertEqual(plan['rmi'], [])
        self.assertEqual(plan['notes'], [n for n in plan['notes'] if n.startswith('dev image age-out skipped: repo reference scan failed')])
        self.assertTrue(plan['notes'])

    def test_h_no_known_checkouts_skips_the_dev_rule_with_a_note(self):
        refs, error = cleanup.dockerfile_refs([])
        self.assertEqual(error, 'no checkouts known')
        ctx = cleanup.Ctx(cleanup.parse_args(['--only', 'docker']))
        ctx.docker_up = True
        docker = Docker([self.image(created=3)])
        with patch.object(cleanup, 'run', side_effect=lambda cmd, **k: (0, '', '') if cmd[:2] == ['docker', 'system'] else docker(cmd, **k)):
            plan = cleanup.plan_docker(ctx)
        self.assertEqual(plan['rmi'], [])
        self.assertEqual(plan['notes'], ['dev image age-out skipped: no checkouts known'])

    def test_i_old_created_but_recent_tag_is_kept(self):
        self.assertEqual(self.plan(Docker([self.image(created=400, last=1)]))[0], [])

    def test_j_unknown_last_tag_time_keeps_the_image(self):
        """A pulled image has no tag time and an old Created: its age is unknown, so it is never a dev candidate."""
        for last in ('0001-01-01T00:00:00Z', '', 'garbage'):
            with self.subTest(last=last):
                self.assertEqual(self.plan(Docker([self.image(created=30, last=last)]))[0], [])

    def test_k_multi_tag_image_is_one_candidate_and_apply_untags_each_ref_without_force(self):
        tags = ['cratis/chronicle:local-development', 'cratis/chronicle:latest-development']
        docker = Docker([self.image(tags, created=9, last=3)])
        cands, kept, _ = self.plan(docker)
        self.assertEqual(len(cands), 1)
        self.assertEqual(cands[0]['refs'], tags)
        with patch.object(cleanup, 'run', side_effect=docker):
            cleanup.remove_image(cands[0])
        self.assertEqual(docker.rmis(), [['docker', 'rmi', t] for t in tags])
        self.assertEqual(cands[0]['result'], 'removed')
        self.assertFalse([c for c in docker.calls if '-f' in c[:3] or '--force' in c])

    def test_l_multi_tag_with_a_release_tag_stays_kept_by_the_general_rule(self):
        docker = Docker([self.image(['cratis/chronicle:19.1.0', 'cratis/chronicle:local-development'], created=30, last=30)])
        cands, kept, _ = self.plan(docker)
        self.assertEqual(cands, [])
        self.assertEqual(len(kept), 1)
        self.assertIn('tags', kept[0]['reason'])

    def test_m_foreign_images_are_not_touched_by_the_dev_rule(self):
        self.assertEqual(self.plan(Docker([self.image('mongo:dev', created=3, last=3)]))[0], [])

    def test_n_ghcr_images_qualify(self):
        cands, _, _ = self.plan(Docker([self.image('ghcr.io/cratis/ante:main-abc', created=3)]))
        self.assertEqual(len(cands), 1)

    def test_o_apply_skips_a_ref_whose_id_changed_or_vanished(self):
        item = {'id': 'sha256:a', 'tags': ['cratis/x:dev'], 'refs': ['cratis/x:dev'], 'dev': True}
        for docker in (Docker([('sha256:other', ['cratis/x:dev'], 1, 1, [])]), Docker([], inspect_rc=1)):
            with self.subTest(ids=docker.ids):
                item.pop('result', None)
                with patch.object(cleanup, 'run', side_effect=docker):
                    cleanup.remove_image(item)
                self.assertEqual(docker.rmis(), [])
                self.assertTrue(item['result'].startswith('skipped'))
                self.assertFalse(item.get('failed'))

    def test_p_unreadable_pin_file_fails_closed_with_the_dev_rule_on(self):
        docker = Docker([self.image(created=3)])
        with patch.object(cleanup, 'run', side_effect=docker), patch('builtins.open', side_effect=PermissionError('denied')):
            cands, kept, err = cleanup.plan_rmi(7, None, 2, set())
        self.assertEqual((cands, kept), ([], []))
        self.assertIn('cannot read docker pin file', err)
        self.assertEqual(docker.calls, [])

    def test_q_docker_errors_mean_no_candidates(self):
        for failing in (['docker', 'ps'], ['docker', 'inspect'], ['docker', 'image', 'ls']):
            with self.subTest(failing=failing):
                docker = Docker([self.image(created=3)], containers=[('c1', 'sha256:zzz', 'x')])
                real = docker.__call__
                def run(cmd, **k):
                    return (1, '', 'daemon error') if cmd[:len(failing)] == failing else real(cmd, **k)
                with patch.object(cleanup, 'run', side_effect=run):
                    cands, kept, err = cleanup.plan_rmi(7, None, 2, set())
                self.assertEqual(cands, [])
                self.assertTrue(err)

    def test_r_apply_recompute_never_forces_and_skips_when_a_container_uses_the_image(self):
        ctx = cleanup.Ctx(cleanup.parse_args([]))
        ctx.checkouts = [self.checkout]
        docker = Docker([self.image(created=3)], containers=[('c1', 'sha256:a', 'x')])
        d = {'prunes': [], 'rmi': [], 'rmi_kept': [], 'error': None}
        with patch.object(cleanup, 'run', side_effect=docker):
            cleanup.apply_docker(ctx, d)
        self.assertEqual(docker.rmis(), [])

    def test_s_apply_removes_unused_dev_image_after_recompute(self):
        ctx = cleanup.Ctx(cleanup.parse_args([]))
        ctx.checkouts = [self.checkout]
        docker = Docker([self.image(created=3)])
        d = {'prunes': [], 'rmi': [], 'rmi_kept': [], 'error': None}
        with patch.object(cleanup, 'run', side_effect=docker):
            cleanup.apply_docker(ctx, d)
        self.assertEqual(docker.rmis(), [['docker', 'rmi', 'cratis/chronicle:19.114.0-development']])

    def test_dev_flag_default_and_validation(self):
        self.assertEqual(cleanup.parse_args([]).dev_image_age_days, 2)
        self.assertEqual(cleanup.parse_args(['--dev-image-age-days', '0.5']).dev_image_age_days, 0.5)


DIGEST_A = 'sha256:' + 'a' * 64
DIGEST_B = 'sha256:' + 'b' * 64


class UnresolvedReferenceTests(ImageCase):
    """A Dockerfile/compose reference that does not name one literal repo:tag protects fail-closed."""

    def planned(self, grep_out, image=None, **kw):
        image = image or self.image('cratis/chronicle:19.114.0-development', created=30, last=30,
                                    digests=['cratis/chronicle@' + DIGEST_A])
        docker = Docker([image], grep=(0, grep_out, ''))
        return self.plan(docker, **kw), docker

    def assert_protected(self, grep_out, image=None):
        (cands, kept, err), _ = self.planned(grep_out, image)
        self.assertEqual((cands, err), ([], None))
        self.assertEqual(len(kept), 1, kept)
        self.assertIn('Dockerfile/compose', kept[0]['reason'])

    def test_tagless_reference_protects_every_tag_of_the_repository(self):
        for line in ('cratis/chronicle\n', 'ghcr.io/cratis/chronicle\n', 'cratis/chronicle:latest\n', 'docker.io/cratis/chronicle:latest\n'):
            with self.subTest(line=line):
                self.assert_protected(line)
                self.assert_protected(line, self.image('cratis/chronicle:4.210.2', created=30, last=30))  # general rule too

    def test_variable_tag_protects_every_tag_of_the_repository(self):
        for line in ('cratis/chronicle:${VERSION}\n', 'cratis/chronicle:$VERSION\n', 'cratis/chronicle:${V:-1.0}\n',
                     'cratis/chronicle:1.0-${SUFFIX}\n'):
            with self.subTest(line=line):
                self.assert_protected(line)

    def test_digest_reference_protects_only_the_image_with_that_digest(self):
        self.assert_protected('cratis/other@' + DIGEST_A + '\n')  # digest match, whatever the repo/tag
        (cands, kept, _), _ = self.planned('cratis/chronicle@' + DIGEST_B + '\n')
        self.assertEqual((len(cands), kept), (1, []))  # a different digest does not protect it
        self.assert_protected('cratis/chronicle:1.0@' + DIGEST_A + '\n')

    def test_unparsable_repository_protects_by_literal_prefix(self):
        for line in ('cratis/${NAME}:1\n', 'ghcr.io/cratis/chron${X}:1\n', 'cratis/Chronicle:1\n', 'cratis/\n'):
            with self.subTest(line=line):
                self.assert_protected(line)

    def test_unrelated_repository_is_not_protected_by_a_variable_reference(self):
        (cands, kept, _), _ = self.planned('cratis/other:${VERSION}\n')
        self.assertEqual((len(cands), kept), (1, []))

    def test_general_age_rule_keeps_a_referenced_old_release_image(self):
        image = self.image('cratis/stage:4.210.2', created=30, last=30)
        (cands, kept, _), _ = self.planned('cratis/stage:4.210.2\n', image)
        self.assertEqual((cands, len(kept)), ([], 1))
        (cands, kept, _), _ = self.planned('cratis/other:1.0.0\n', image)
        self.assertEqual((len(cands), kept), (1, []))

    def test_failed_scan_skips_every_cratis_removal_but_not_foreign_images(self):
        images = [self.image('cratis/stage:4.210.2', created=30, last=30), self.image(created=30, iid='sha256:d'),
                  self.image('mongo:7', created=30, last=30, iid='sha256:m')]
        docker = Docker(images)
        with patch.object(cleanup, 'run', side_effect=docker):
            cands, kept, err = cleanup.plan_rmi(7, None, 2, None)
        self.assertEqual((self.ids(cands), kept, err), (['sha256:m'], [], None))
        with patch.object(cleanup, 'run', side_effect=docker):
            cands, _, _ = cleanup.plan_rmi(7)  # no scan result at all
        self.assertEqual(self.ids(cands), ['sha256:m'])

    def test_scan_includes_untracked_files(self):
        _, docker = self.planned('')
        scan = next(c for c in docker.calls if c[:2] == ['git', 'grep'])
        self.assertIn('--untracked', scan)


class DigestOnlyImageTests(ImageCase):
    """An image pulled by digest (or left untagged) has no RepoTags; its repository comes from RepoDigests."""

    def only_digest(self, repo='cratis/chronicle', digest=DIGEST_A, created=30):
        return ('sha256:d1', [], created, 30, [f'{repo}@{digest}'])

    def test_repo_level_references_protect_a_digest_only_image(self):
        for line in ('cratis/chronicle\n', 'cratis/chronicle:latest\n', 'cratis/chronicle:${VERSION}\n',
                     'ghcr.io/cratis/chronicle:$V\n', 'cratis/${NAME}:1\n', 'cratis/chron${X}\n'):
            with self.subTest(line=line):
                docker = Docker([self.only_digest()], grep=(0, line, ''))
                cands, kept, err = self.plan(docker)
                self.assertEqual((cands, err, len(kept)), ([], None, 1))

    def test_digest_only_image_of_an_unreferenced_repo_is_still_a_general_candidate(self):
        docker = Docker([self.only_digest()], grep=(0, 'cratis/other:${V}\n', ''))
        self.assertEqual(len(self.plan(docker)[0]), 1)

    def test_exact_digest_reference_still_protects(self):
        docker = Docker([self.only_digest()], grep=(0, 'cratis/elsewhere@' + DIGEST_A + '\n', ''))
        self.assertEqual(len(self.plan(docker)[1]), 1)

    def test_pin_on_the_repository_protects_a_digest_only_image(self):
        docker = Docker([self.only_digest()])
        cands, kept, _ = self.plan(docker, pins='cratis/chronicle\n')
        self.assertEqual((cands, len(kept)), ([], 1))

    def test_a_container_naming_the_digest_or_a_tagless_name_keeps_the_image(self):
        for name in ('cratis/chronicle@' + DIGEST_A, 'docker.io/cratis/chronicle@' + DIGEST_A):
            with self.subTest(name=name):
                docker = Docker([self.only_digest()], containers=[('c1', 'sha256:zzz', name)])
                self.assertEqual(self.plan(docker)[:2], ([], []))
        tagged = self.image('cratis/chronicle:latest', created=30, last=30)
        for name in ('cratis/chronicle', 'docker.io/cratis/chronicle'):
            with self.subTest(name=name):
                docker = Docker([tagged], containers=[('c1', 'sha256:zzz', name)])
                self.assertEqual(self.plan(docker)[:2], ([], []))


class RealScanTests(ImageCase):
    """The real git grep + parser over files on disk (no fake runner)."""

    def scan(self, **files):
        import subprocess
        repo = self.state / 'repo'
        repo.mkdir()
        env = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_SYSTEM': os.devnull}
        subprocess.run(['git', 'init', '-q', str(repo)], check=True, env=env)
        for name, text in files.items():
            (repo / name.replace('__', '/')).parent.mkdir(parents=True, exist_ok=True)
            (repo / name.replace('__', '/')).write_text(text)
        refs, error = cleanup.dockerfile_refs([type('C', (), {'path': str(repo), 'exists': True})()])
        self.assertIsNone(error)
        return refs

    def test_untracked_dockerfile_forms_all_protect(self):
        refs = self.scan(Dockerfile='FROM cratis/chronicle AS base\nFROM cratis/web:${VERSION}\nFROM cratis/api@' + DIGEST_A + '\n',
                         **{'docker__compose.yml': 'services:\n  a:\n    image: "ghcr.io/cratis/stage:$TAG"\n  b:\n    image: cratis/pinned:1.2.3\n'})
        for tag in ('cratis/chronicle:1.0-development', 'cratis/web:9.9', 'cratis/stage:x', 'cratis/pinned:1.2.3'):
            self.assertTrue(refs.protecting([tag], []), tag)
        self.assertTrue(refs.protecting([], ['cratis/api@' + DIGEST_A]))
        self.assertIsNone(refs.protecting(['cratis/pinned:9.9.9'], []))
        self.assertIsNone(refs.protecting(['cratis/unrelated:1'], []))


if __name__ == '__main__':
    unittest.main()
