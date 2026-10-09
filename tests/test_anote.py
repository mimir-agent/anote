import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

CLI = str(Path(__file__).resolve().parent.parent / "anote")


class Base(unittest.TestCase):
    today = "2026-10-09"

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_cli(self, *args, today=None, stdin=""):
        env = dict(os.environ, ANOTE_GRAPH=self.tmp, ANOTE_TODAY=today or self.today)
        r = subprocess.run([sys.executable, "-I", CLI] + list(args),
                           capture_output=True, text=True, env=env, input=stdin)
        return r.returncode, r.stdout, r.stderr

    def add(self, title, *extra, source="observed", type_="concept"):
        args = ["add", title, "--source", source]
        if "--type" not in extra:
            args += ["--type", type_]
        code, out, err = self.run_cli(*(args + list(extra)))
        self.assertEqual(code, 0, err)
        return out

    def note_path(self, slug):
        return Path(self.tmp) / "notes" / (slug + ".md")


class TestWriting(Base):
    def test_source_is_required(self):
        code, _, err = self.run_cli("add", "No source", "--type", "concept")
        self.assertEqual(code, 2)
        self.assertIn("--source", err)

    def test_add_then_show(self):
        self.add("Cron falls back to email", "--body", "It went to Gmail.",
                 "--version", "hermes 0.19.0", "--tag", "cron,delivery")
        code, out, _ = self.run_cli("show", "cron-falls-back-to-email")
        self.assertEqual(code, 0)
        self.assertIn("# Cron falls back to email", out)
        self.assertIn("source: observed", out)
        self.assertIn("version: hermes 0.19.0", out)
        self.assertIn("It went to Gmail.", out)
        self.assertIn("tags: cron, delivery", out)

    def test_default_review_depends_on_source(self):
        self.add("A", source="inferred")
        self.add("B", source="told")
        self.assertIn("review: 2026-11-08", self.note_path("a").read_text())
        self.assertIn("review: 2027-04-07", self.note_path("b").read_text())

    def test_review_none_removes_date(self):
        self.add("A", "--review", "none")
        self.assertNotIn("review:", self.note_path("a").read_text())

    def test_duplicate_slug_refused(self):
        self.add("Same")
        code, _, err = self.run_cli("add", "Same", "--source", "told", "--type", "concept")
        self.assertEqual(code, 2)
        self.assertIn("already exists", err)

    def test_append_and_set(self):
        self.add("A", "--body", "one")
        self.assertEqual(self.run_cli("append", "a", "two")[0], 0)
        self.assertEqual(self.run_cli("set", "a", "version", "x 1.0")[0], 0)
        out = self.run_cli("show", "a")[1]
        self.assertIn("one\n\ntwo", out)
        self.assertIn("version: x 1.0", out)
        self.assertEqual(self.run_cli("set", "a", "source", "bogus")[0], 2)

    def test_body_from_stdin(self):
        code, _, err = self.run_cli("add", "Piped", "--source", "told", "--type", "concept", "--body", "-", stdin="from stdin\n")
        self.assertEqual(code, 0, err)
        self.assertIn("from stdin", self.run_cli("show", "piped")[1])


class TestLinks(Base):
    def setUp(self):
        super().setUp()
        for t in ("Alpha", "Beta", "Gamma"):
            self.add(t)

    def test_link_shows_both_directions(self):
        self.assertEqual(self.run_cli("link", "alpha", "expands-on", "beta", "--note", "more detail")[0], 0)
        out_a = self.run_cli("show", "alpha")[1]
        out_b = self.run_cli("show", "beta")[1]
        self.assertIn("expands-on", out_a)
        self.assertIn("-> beta", out_a)
        self.assertIn("more detail", out_a)
        self.assertIn("<- alpha", out_b)

    def test_unknown_type_rejected(self):
        code, _, err = self.run_cli("link", "alpha", "befriends", "beta")
        self.assertEqual(code, 2)
        self.assertIn("unknown link type", err)

    def test_aliases_and_spaces(self):
        self.run_cli("link", "alpha", "helpful background", "beta")
        self.run_cli("link", "alpha", "leads", "gamma")
        out = self.run_cli("show", "alpha")[1]
        self.assertIn("helpful-background", out)
        self.assertIn("leads-to", out)

    def test_link_is_idempotent_and_no_self_links(self):
        self.run_cli("link", "alpha", "relates", "beta")
        code, out, _ = self.run_cli("link", "alpha", "relates", "beta")
        self.assertIn("already linked", out)
        self.assertEqual(self.note_path("alpha").read_text().count("[[beta]]"), 1)
        self.assertEqual(self.run_cli("link", "alpha", "relates", "alpha")[0], 2)

    def test_unlink(self):
        self.run_cli("link", "alpha", "relates", "beta")
        self.assertEqual(self.run_cli("unlink", "alpha", "beta")[0], 0)
        self.assertNotIn("[[beta]]", self.note_path("alpha").read_text())
        self.assertEqual(self.run_cli("unlink", "alpha", "beta")[0], 3)

    def test_add_with_link_flag(self):
        self.add("Delta", "--link", "supports:alpha")
        self.assertIn("supports [[alpha]]", self.note_path("delta").read_text())
        code, _, err = self.run_cli("add", "Eps", "--source", "told", "--type", "concept", "--link", "supports:nope")
        self.assertEqual(code, 3)
        self.assertFalse(self.note_path("eps").exists())

    def test_neighbors_depth(self):
        self.run_cli("link", "alpha", "leads-to", "beta")
        self.run_cli("link", "beta", "leads-to", "gamma")
        one = self.run_cli("neighbors", "alpha")[1]
        two = self.run_cli("neighbors", "alpha", "--depth", "2")[1]
        self.assertNotIn("gamma", one)
        self.assertIn("gamma", two)
        only = self.run_cli("neighbors", "beta", "--type", "leads-to", "--json")[1]
        self.assertEqual(len(json.loads(only)), 2)


class TestLookup(Base):
    def test_not_found_and_ambiguous(self):
        self.add("Cron one")
        self.add("Cron two")
        self.assertEqual(self.run_cli("show", "nothing-here")[0], 3)
        code, _, err = self.run_cli("show", "cron")
        self.assertEqual(code, 3)
        self.assertIn("ambiguous", err)

    def test_resolve_by_title_and_prefix(self):
        self.add("Web extract needs a backend")
        self.assertEqual(self.run_cli("show", "Web extract needs a backend")[0], 0)
        self.assertEqual(self.run_cli("show", "web-extract")[0], 0)

    def test_search_ranks_title_over_body(self):
        self.add("Email fallback", "--body", "nothing relevant")
        self.add("Something else", "--body", "mentions email once")
        out = self.run_cli("search", "email")[1].splitlines()
        self.assertTrue(out[0].startswith("email-fallback"))

    def test_search_budget_truncates(self):
        for i in range(6):
            self.add("Topic %d" % i, "--body", "shared word " * 30)
        full = self.run_cli("search", "shared", "--json")[1]
        small = self.run_cli("search", "shared", "--budget", "60", "--json")[1]
        self.assertLess(len(json.loads(small)), len(json.loads(full)))

    def test_daily_log_is_searchable_and_showable(self):
        self.assertEqual(self.run_cli("log", "restarted the gateway by hand")[0], 0)
        self.assertIn("daily/2026-10-09", self.run_cli("search", "gateway")[1])
        self.assertIn("restarted the gateway", self.run_cli("show", "2026-10-09")[1])

    def test_list_filters(self):
        self.add("A", "--tag", "x")
        self.add("B", "--tag", "y")
        out = self.run_cli("list", "--tag", "x")[1]
        self.assertIn("a ", out)
        self.assertNotIn("\nb ", "\n" + out)


class TestStaleness(Base):
    def test_stale_and_confirm(self):
        self.add("Old fact", "--review", "+10d")
        self.add("Fresh fact", "--review", "+100d")
        self.assertEqual(self.run_cli("stale")[1].strip(), "nothing due")
        late = self.run_cli("stale", today="2026-10-25")[1]
        self.assertIn("old-fact", late)
        self.assertNotIn("fresh-fact", late)
        self.assertIn("overdue by", late)
        self.assertEqual(self.run_cli("confirm", "old-fact", "--review", "+30d", today="2026-10-25")[0], 0)
        self.assertEqual(self.run_cli("stale", today="2026-10-25")[1].strip(), "nothing due")
        self.assertIn("confirmed: 2026-10-25", self.note_path("old-fact").read_text())

    def test_within_window(self):
        self.add("Soon", "--review", "+10d")
        self.assertIn("soon", self.run_cli("stale", "--within", "14d")[1])
        self.assertNotIn("soon", self.run_cli("stale", "--within", "3d")[1])

    def test_undated_notes_listed_separately(self):
        self.add("No date", "--review", "none")
        self.assertIn("no review date: no-date", self.run_cli("stale")[1])


class TestSupersede(Base):
    def test_superseded_hidden_from_search_and_list(self):
        self.add("Old claim", "--body", "restart needed")
        self.add("New claim", "--body", "restart not needed")
        self.assertEqual(self.run_cli("supersede", "old-claim", "new-claim")[0], 0)
        self.assertNotIn("old-claim", self.run_cli("search", "restart")[1])
        self.assertIn("old-claim", self.run_cli("search", "restart", "--all")[1])
        self.assertNotIn("old-claim", self.run_cli("list")[1])
        shown = self.run_cli("show", "old-claim")[1]
        self.assertIn("STATUS: superseded by [new-claim]", shown)
        self.assertIn("supersedes: old-claim", self.run_cli("show", "new-claim")[1])


class TestCheck(Base):
    def test_clean_graph_passes(self):
        self.add("A")
        self.add("B", "--link", "relates:a")
        self.assertEqual(self.run_cli("check")[0], 0)

    def test_broken_link_fails(self):
        self.add("A")
        p = self.note_path("a")
        p.write_text(p.read_text().replace(
            "status: active\n", "status: active\nlinks:\n  - relates [[ghost]]\n"))
        code, out, _ = self.run_cli("check")
        self.assertEqual(code, 1)
        self.assertIn("link to missing note 'ghost'", out)

    def test_missing_source_and_bad_date_fail(self):
        Path(self.tmp, "notes").mkdir(parents=True)
        Path(self.tmp, "notes", "bad.md").write_text("---\ntitle: Bad\nreview: soon\n---\nbody\n")
        code, out, _ = self.run_cli("check")
        self.assertEqual(code, 1)
        self.assertIn("source is missing", out)
        self.assertIn("review is not a date", out)

    def test_unparseable_file_reported_not_crashed(self):
        Path(self.tmp, "notes").mkdir(parents=True)
        Path(self.tmp, "notes", "junk.md").write_text("no frontmatter here\n")
        code, out, _ = self.run_cli("check")
        self.assertEqual(code, 1)
        self.assertIn("no frontmatter", out)

    def test_warns_on_orphans_and_missing_wikilinks(self):
        self.add("Lonely", "--body", "see [[Nowhere]]")
        out = self.run_cli("check")[1]
        self.assertIn("no links in or out", out)
        self.assertIn("[[Nowhere]]", out)


class TestFileFormat(Base):
    def test_rewrite_is_stable(self):
        self.add("Stable", "--body", "line one\n\nline two", "--tag", "a,b")
        self.add("Other")
        self.run_cli("link", "stable", "relates", "other", "--note", "same topic")
        before = self.note_path("stable").read_text()
        self.run_cli("set", "stable", "version", "v1")
        self.run_cli("set", "stable", "version", "v1")
        after = self.note_path("stable").read_text()
        self.assertEqual(after.count("version: v1"), 1)
        self.assertIn("relates [[other]] | same topic", after)
        self.assertIn("line one\n\nline two", after)
        self.assertEqual(before.split("links:")[1], after.split("links:")[1])

    def test_no_stray_temp_files(self):
        self.add("A")
        self.add("B")
        self.run_cli("link", "a", "relates", "b")
        leftovers = [p.name for p in Path(self.tmp, "notes").iterdir() if p.name.startswith(".")]
        self.assertEqual(leftovers, [])


class TestTypes(Base):
    def add_raw(self, title, *args, source="told"):
        return self.run_cli("add", title, "--source", source, *args)

    def test_type_is_required(self):
        code, _, err = self.run_cli("add", "X", "--source", "told")
        self.assertEqual(code, 2)
        self.assertIn("--type", err)

    def test_types_outside_the_set_are_rejected(self):
        for bad in ("trip", "meeting", "place", "note"):
            self.assertEqual(self.add_raw("X", "--type", bad)[0], 2, bad)

    def test_types_lists_definitions_and_links(self):
        out = self.run_cli("types")[1]
        self.assertIn("assertion", out)
        self.assertIn("expands-on", out)

    def test_reference_tags_in_order(self):
        code, _, err = self.add_raw("Essay", "--type", "reference", "--media", "text", "--form", "article")
        self.assertEqual(code, 0, err)
        self.assertIn("type: reference text article", self.note_path("essay").read_text())
        self.assertIn("type: #reference #text #article", self.run_cli("show", "essay")[1])

    def test_reference_media_alone_is_fine(self):
        self.assertEqual(self.add_raw("Talk", "--type", "reference", "--media", "audio")[0], 0)

    def test_reference_form_must_match_media(self):
        code, _, err = self.add_raw("Movie", "--type", "reference", "--media", "text", "--form", "film")
        self.assertEqual(code, 2)
        self.assertIn("goes with media", err)

    def test_reference_form_needs_its_media_tag(self):
        code, _, err = self.add_raw("Book", "--type", "reference", "--form", "book")
        self.assertEqual(code, 2)
        self.assertIn("goes after its media tag", err)

    def test_only_references_take_media(self):
        code, _, err = self.add_raw("Idea", "--type", "concept", "--media", "text")
        self.assertEqual(code, 2)
        self.assertIn("single type tag", err)

    def test_artifact_form_is_optional_and_limited(self):
        self.assertEqual(self.add_raw("Draft", "--type", "artifact")[0], 0)
        self.assertEqual(self.add_raw("Post", "--type", "artifact", "--form", "post")[0], 0)
        self.assertEqual(self.add_raw("Odd", "--type", "artifact", "--form", "fragment")[0], 2)

    def test_hand_edited_tag_order_is_caught_by_check(self):
        self.add_raw("Essay", "--type", "reference", "--media", "text", "--form", "article")
        p = self.note_path("essay")
        p.write_text(p.read_text().replace("reference text article", "reference article text"))
        code, out, _ = self.run_cli("check")
        self.assertEqual(code, 1)
        self.assertIn("goes after its media tag", out)

    def test_person_needs_the_flag(self):
        code, _, err = self.add_raw("Alex", "--type", "person")
        self.assertEqual(code, 2)
        self.assertIn("--person-ok", err)
        self.assertFalse(self.note_path("alex").exists())
        self.assertEqual(self.add_raw("Alex", "--type", "person", "--person-ok")[0], 0)

    def test_cannot_retype_into_person(self):
        self.add("Alex")
        code, _, err = self.run_cli("set", "alex", "type", "person")
        self.assertEqual(code, 2)
        self.assertIn("--person-ok", err)

    def test_stance_is_for_assertions_only(self):
        self.assertEqual(self.add_raw("Idea", "--type", "concept", "--stance", "held")[0], 2)
        self.assertEqual(self.add_raw("Claim", "--type", "assertion", "--stance", "unheld")[0], 0)
        self.assertIn("stance: unheld", self.run_cli("show", "claim")[1])

    def test_unstated_stance_says_so(self):
        self.add_raw("Claim", "--type", "assertion")
        self.assertIn("not anyone's position", self.run_cli("show", "claim")[1])

    def test_set_stance_and_retyping_drops_it(self):
        self.add_raw("Claim", "--type", "assertion")
        self.assertEqual(self.run_cli("set", "claim", "stance", "held")[0], 0)
        self.assertIn("stance: held", self.note_path("claim").read_text())
        self.assertEqual(self.run_cli("set", "claim", "type", "question")[0], 0)
        self.assertNotIn("stance:", self.note_path("claim").read_text())
        self.assertEqual(self.run_cli("set", "claim", "stance", "held")[0], 2)


class TestTypeRules(Base):
    def test_fragment_must_link_to_a_reference(self):
        self.add("Essay", "--type", "reference", "--media", "text")
        self.add("Wear shows use", "--type", "fragment")
        code, out, _ = self.run_cli("check")
        self.assertEqual(code, 1)
        self.assertIn("must link back to the reference", out)
        self.run_cli("link", "wear-shows-use", "references", "essay")
        self.assertEqual(self.run_cli("check")[0], 0)

    def test_fragment_linked_to_a_non_reference_still_fails(self):
        self.add("Other")
        self.add("Piece", "--type", "fragment", "--link", "references:other")
        self.assertEqual(self.run_cli("check")[0], 1)

    def test_question_with_competing_assertions(self):
        self.add("Wear in software?", "--type", "question")
        self.add("Software can show wear", "--type", "assertion", "--stance", "held",
                 "--link", "addresses:wear-in-software")
        self.add("Software should not show wear", "--type", "assertion", "--stance", "held",
                 "--link", "addresses:wear-in-software")
        self.run_cli("link", "software-should-not-show-wear", "opposes", "software-can-show-wear")
        out = self.run_cli("neighbors", "wear-in-software", "--type", "addresses")[1]
        self.assertIn("software-can-show-wear", out)
        self.assertIn("software-should-not-show-wear", out)
        self.assertEqual(self.run_cli("check")[0], 0)

    def test_list_and_search_filter_by_type(self):
        self.add("Open one", "--type", "question", "--body", "shared word")
        self.add("Claim one", "--type", "assertion", "--body", "shared word")
        listed = self.run_cli("list", "--type", "question")[1]
        self.assertIn("open-one", listed)
        self.assertNotIn("claim-one", listed)
        found = self.run_cli("search", "shared", "--type", "assertion")[1]
        self.assertIn("claim-one", found)
        self.assertNotIn("open-one", found)


class TestPromote(Base):
    def test_promote_keeps_source_and_leaves_a_trail(self):
        self.run_cli("log", "roots need water", "--source", "inferred")
        self.assertIn("[1] - ", self.run_cli("show", "2026-10-09")[1])
        code, _, err = self.run_cli("promote", "2026-10-09", "1", "Roots need water", "--type", "assertion")
        self.assertEqual(code, 0, err)
        text = self.note_path("roots-need-water").read_text()
        self.assertIn("source: inferred", text)
        self.assertIn("roots need water", text)
        self.assertIn("promoted line 1", self.run_cli("show", "2026-10-09")[1])

    def test_promote_needs_a_real_line_a_type_and_a_day(self):
        self.run_cli("log", "something")
        self.assertEqual(self.run_cli("promote", "2026-10-09", "9", "T", "--type", "concept")[0], 3)
        self.assertEqual(self.run_cli("promote", "2026-10-09", "1", "T")[0], 2)
        self.assertEqual(self.run_cli("promote", "2026-10-08", "1", "T", "--type", "concept")[0], 3)
        self.assertFalse(self.note_path("t").exists())


if __name__ == "__main__":
    unittest.main()
